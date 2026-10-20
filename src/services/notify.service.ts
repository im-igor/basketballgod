import { InlineKeyboard, type Api } from 'grammy';
import { env, TEAMS } from '../config/env.js';
import {
  getBudget,
  getBudgetById,
  getCharges,
  getDebtors,
  setBudgetMessage,
} from '../db/repos/budgets.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listAllGamesForMonth } from '../db/repos/games.repo.js';
import { buildBudgetMessage, buildDebtorsMessage, type ChargeView } from '../domain/messages.js';
import { sharedCoachBudgetsReady, usesSharedCoach } from '../domain/budget.js';
import { gamesForPlayers } from '../domain/gamefee.js';
import { chatStatusesByLogin } from './chatCheck.service.js';
import { monthLabel } from '../domain/dates.js';
import { monthRange } from '../domain/dates.js';
import { calendarFingerprint, correctionNote, isLegacyAutoCorrectionNote, snapshotEvents } from '../domain/budgetCorrections.js';
import { listEvents } from '../google/calendar.js';
import { log } from '../util/logger.js';
import type { BudgetDetails, MonthlyPayout, Team } from '../db/types.js';
import { updateBudgetCorrection } from './budget.service.js';
import { buildMonthlyPayoutMessage } from '../domain/payouts.js';

const payment = { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL };

/**
 * Собрать текст сообщения сбора из сохранённого бюджета (с пометками оплат).
 * В черновике для админа показываем сохранённую при сборке проверку чата.
 * `api` оставлен для явной проверки актуального состояния без сохранения.
 * Для публикации в чат команды `api` не передаём — сообщение остаётся чистым.
 */
export async function renderBudgetFromDb(
  budgetId: number,
  opts: { api?: Api; savedChatStatus?: boolean } = {},
): Promise<{
  team: Team;
  chatId: number | null;
  messageId: number | null;
  text: string;
} | null> {
  const budget = await getBudgetById(budgetId);
  if (!budget || !budget.details) return null;
  const [charges, tariffs, games] = await Promise.all([
    getCharges(budgetId),
    getTariffs(),
    listAllGamesForMonth(budget.month, budget.year),
  ]);
  const chatStatuses = opts.savedChatStatus
    ? new Map(Object.entries(budget.details.chat_check?.statuses ?? {}))
    : opts.api
      ? await chatStatusesByLogin(opts.api, budget.team, charges.map((c) => c.tg_login))
      : new Map();
  const views: ChargeView[] = charges.map((c) => ({
    name: c.name,
    tg_login: c.tg_login,
    game_amount: c.game_amount,
    extra_items: c.extra_items,
    amount: c.amount,
    paid: c.paid,
    chatStatus: chatStatuses.get(c.tg_login.toLowerCase()),
  }));
  const details = budget.details as BudgetDetails;
  const correction = details.correction;
  const showCurrentAutoNote = correction && (!correction.note_edited || isLegacyAutoCorrectionNote(correction));
  const previewDetails = budget.message_id == null && correction && showCurrentAutoNote
    ? { ...details, correction: { ...correction, note: correctionNote(correction) } }
    : details;
  const text = buildBudgetMessage({
    team: budget.team,
    month: budget.month,
    year: budget.year,
    details: previewDetails,
    tariffs,
    charges: views,
    games: gamesForPlayers(games, charges.map((c) => c.player_id)),
    payment,
  });
  return { team: budget.team, chatId: budget.chat_id, messageId: budget.message_id, text };
}

/** Отправить сообщение сбора в чат команды и запомнить message_id. */
export async function sendBudgetToChat(api: Api, budgetId: number): Promise<void> {
  let budget = await getBudgetById(budgetId);
  if (!budget) throw new Error(`Бюджет #${budgetId} не найден`);
  if (budget.message_id != null) throw new Error('Сбор уже опубликован в чате команды');
  if (budget.details?.correction && !budget.details.correction.reviewed) {
    throw new Error('Подтверди корректировки перед публикацией');
  }
  // Старый подтверждённый черновик мог хранить прежний автотекст с названием команды.
  // Перед отправкой сохраняем тот же текст, который показан в предварительном просмотре.
  const correctionToNormalize = budget.details?.correction;
  if (correctionToNormalize && (!correctionToNormalize.note_edited || isLegacyAutoCorrectionNote(correctionToNormalize)) &&
    correctionToNormalize.note !== correctionNote(correctionToNormalize)) {
    await updateBudgetCorrection(budget.month, budget.year, { ...correctionToNormalize, note_edited: false });
    budget = await getBudgetById(budgetId);
    if (!budget) throw new Error(`Бюджет #${budgetId} не найден`);
  }
  const snapshot = budget.details?.event_snapshot;
  const correction = budget.details?.correction;
  if (snapshot || correction?.source_fingerprint) {
    const { from, to } = monthRange(budget.month, budget.year);
    const [redEvents, blackEvents, tariffs] = await Promise.all([
      listEvents('RED', from, to), listEvents('BLACK', from, to), getTariffs(),
    ]);
    if (snapshot) {
      const current = snapshotEvents([...redEvents, ...blackEvents], tariffs);
      const key = (events: typeof current.events) => events
        .map((e) => `${e.team}:${e.uid}:${e.start}:${e.paid_coach}:${e.paid_gym}`)
        .sort().join('\n');
      if (key(current.events) !== key(snapshot.events) ||
        current.coach_rate !== snapshot.coach_rate || current.gym_rate !== snapshot.gym_rate ||
        current.locker_rate !== snapshot.locker_rate) {
        throw new Error('Календарь или тарифы изменились после сборки. Пересобери и проверь черновик');
      }
    }
    if (correction?.source_fingerprint) {
      const { from: sourceFrom, to: sourceTo } = monthRange(correction.source_month, correction.source_year);
      const [sourceRed, sourceBlack] = await Promise.all([
        listEvents('RED', sourceFrom, sourceTo), listEvents('BLACK', sourceFrom, sourceTo),
      ]);
      if (calendarFingerprint([...sourceRed, ...sourceBlack]) !== correction.source_fingerprint) {
        throw new Error('Календарь прошлого месяца изменился. Пересобери и проверь корректировки');
      }
    }
  }
  if (usesSharedCoach(budget.month, budget.year)) {
    const other = await getBudget(budget.team === 'RED' ? 'BLACK' : 'RED', budget.month, budget.year);
    const red = budget.team === 'RED' ? budget : other;
    const black = budget.team === 'BLACK' ? budget : other;
    if (!sharedCoachBudgetsReady(red, black)) {
      throw new Error('Общий черновик устарел. Пересобери бюджеты обеих команд и проверь суммы перед публикацией');
    }
  }
  const rendered = await renderBudgetFromDb(budgetId);
  if (!rendered) throw new Error(`Бюджет #${budgetId} не найден`);
  if (rendered.messageId != null) throw new Error('Сбор уже опубликован в чате команды');
  const chat = env.chats[rendered.team];
  const msg = await api.sendMessage(chat.chatId, rendered.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
  });
  await setBudgetMessage(budgetId, chat.chatId, msg.message_id);
}

/** Отправить зафиксированные в конце месяца суммы администраторам в личку. */
export async function sendMonthlyPayoutToAdmins(
  api: Api,
  payout: MonthlyPayout,
): Promise<number> {
  const text = buildMonthlyPayoutMessage(payout);
  let sent = 0;
  for (const adminId of env.ADMIN_TG_IDS) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: 'HTML' });
      sent++;
    } catch (err) {
      log.warn(
        `[notify] не удалось отправить месячный расчёт админу ${adminId} (нажал ли он Start у бота?)`,
        (err as Error).message,
      );
    }
  }
  if (sent === 0) throw new Error('Месячный расчёт не удалось отправить ни одному администратору');
  return sent;
}

/**
 * Отправить черновики бюджета обеих команд за месяц админам в личку, читая уже
 * собранные бюджеты из БД (без пересчёта по календарю). Используется кнопкой в админке.
 */
export async function sendBudgetDraftsByMonth(
  api: Api,
  month: number,
  year: number,
): Promise<{ sent: number }> {
  let sent = 0;
  for (const team of TEAMS) {
    const budget = await getBudget(team, month, year);
    if (!budget || !budget.details) continue;
    const rendered = await renderBudgetFromDb(budget.id);
    if (!rendered) continue;
    for (const adminId of env.ADMIN_TG_IDS) {
      // Это копия для просмотра; правка и публикация доступны в админке.
      await api
        .sendMessage(adminId, rendered.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        .catch((err) =>
          log.warn(
            `[notify] не удалось отправить черновик админу ${adminId} (нажал ли он Start у бота?)`,
            (err as Error).message,
          ),
        );
    }
    sent++;
  }
  return { sent };
}

/** Перерисовать ранее отправленное сообщение сбора (после отметок оплат). */
export async function refreshBudgetMessage(api: Api, budgetId: number): Promise<boolean> {
  const rendered = await renderBudgetFromDb(budgetId);
  if (!rendered || !rendered.chatId || !rendered.messageId) return false;
  try {
    await api.editMessageText(rendered.chatId, rendered.messageId, rendered.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    log.warn('[notify] не удалось обновить сообщение сбора', (err as Error).message);
    return false;
  }
}

/** Собрать текст напоминания должникам и их число по бюджету (черновику или опубликованному). */
async function buildDebtorsDraft(
  budgetId: number,
): Promise<{ team: Team; text: string; count: number } | null> {
  const budget = await getBudgetById(budgetId);
  if (!budget) return null;
  const debtors = await getDebtors(budgetId);
  const text = buildDebtorsMessage(
    monthLabel(budget.month, budget.year),
    debtors.map((d) => ({ name: d.name, tg_login: d.tg_login, amount: d.amount })),
    payment,
  );
  return { team: budget.team, text, count: debtors.length };
}

/** Отправить напоминание должникам в чат команды. Долги — по любому собранному бюджету. */
export async function sendDebtors(api: Api, budgetId: number): Promise<{ count: number }> {
  const d = await buildDebtorsDraft(budgetId);
  if (!d) throw new Error(`Бюджет #${budgetId} не найден`);
  if (d.count === 0) return { count: 0 };
  const chat = env.chats[d.team];
  await api.sendMessage(chat.chatId, d.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
  });
  return { count: d.count };
}

/**
 * Отправить ЧЕРНОВИК списка должников администраторам в личку — по одному сообщению на команду,
 * с кнопкой «Отправить в чат». В чат команды напоминание уходит только после нажатия кнопки
 * (см. bot/debtorsPublish.ts). count=0 — должников нет, черновик не шлём.
 */
export async function sendDebtorsDraftToAdmins(
  api: Api,
  budgetId: number,
): Promise<{ team: Team; count: number } | null> {
  const d = await buildDebtorsDraft(budgetId);
  if (!d) return null;
  if (d.count === 0) return { team: d.team, count: 0 };

  const header =
    `🧾 <b>Черновик напоминания должникам — ${d.team}</b>\n` +
    `Проверь список и нажми «Отправить в чат».\n\n`;
  const keyboard = new InlineKeyboard().text(`✅ Отправить в чат ${d.team}`, `debtorssend:${budgetId}`);

  for (const adminId of env.ADMIN_TG_IDS) {
    await api
      .sendMessage(adminId, header + d.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard,
      })
      .catch((err) =>
        log.warn(
          `[notify] не удалось отправить черновик должников админу ${adminId}`,
          (err as Error).message,
        ),
      );
  }
  return { team: d.team, count: d.count };
}
