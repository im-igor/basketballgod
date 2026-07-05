import { InlineKeyboard, type Api } from 'grammy';
import { env, TEAMS } from '../config/env.js';
import {
  getBudgetById,
  getCharges,
  getDebtors,
  setBudgetMessage,
} from '../db/repos/budgets.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listGamesForMonth } from '../db/repos/games.repo.js';
import { buildBudgetMessage, buildDebtorsMessage, type ChargeView } from '../domain/messages.js';
import { monthLabel, nextMonthOf } from '../domain/dates.js';
import { log } from '../util/logger.js';
import type { BudgetDetails, Team } from '../db/types.js';
import type { BuiltBudget } from './budget.service.js';

const payment = { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL };

/** Клавиатура под черновиком: правки тренера/товарищеского + публикация. */
export function draftKeyboard(budgetId: number, team: Team): InlineKeyboard {
  return new InlineKeyboard()
    .text('Тренер −', `budcoach:${budgetId}:-1`)
    .text('Тренер +', `budcoach:${budgetId}:1`)
    .text('✏️ коммент', `budnote:${budgetId}`)
    .row()
    .text('🤝 + Товарищеский', `budfriendly:${budgetId}`)
    .text('🗑 убрать посл.', `budfrdel:${budgetId}`)
    .row()
    .text(`✅ Опубликовать в чат ${team}`, `budpub:${budgetId}`);
}

/** Собрать текст сообщения сбора из сохранённого бюджета (с пометками оплат). */
export async function renderBudgetFromDb(budgetId: number): Promise<{
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
    listGamesForMonth(budget.team, budget.month, budget.year),
  ]);
  const views: ChargeView[] = charges.map((c) => ({
    name: c.name,
    tg_login: c.tg_login,
    game_amount: c.game_amount,
    amount: c.amount,
    paid: c.paid,
  }));
  const text = buildBudgetMessage({
    team: budget.team,
    month: budget.month,
    year: budget.year,
    details: budget.details as BudgetDetails,
    tariffs,
    charges: views,
    games: games.map((g) => ({
      played_on: g.played_on,
      opponent: g.opponent,
      fee_per_player: g.fee_per_player,
    })),
    payment,
  });
  return { team: budget.team, chatId: budget.chat_id, messageId: budget.message_id, text };
}

/** Отправить сообщение сбора в чат команды и запомнить message_id. */
export async function sendBudgetToChat(api: Api, budgetId: number): Promise<void> {
  const rendered = await renderBudgetFromDb(budgetId);
  if (!rendered) throw new Error(`Бюджет #${budgetId} не найден`);
  const chat = env.chats[rendered.team];
  const msg = await api.sendMessage(chat.chatId, rendered.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
  });
  await setBudgetMessage(budgetId, chat.chatId, msg.message_id);
}

/**
 * Отправить ЧЕРНОВИКИ бюджета администраторам в личку — отдельным сообщением на
 * каждую команду, с кнопкой «Опубликовать в чат». Сам сбор в чат команды не уходит:
 * его публикует бот после нажатия кнопки (см. bot/budgetPublish.ts), поэтому
 * message_id известен и отметки оплат «+» продолжают работать.
 */
export async function sendBudgetDraftToAdmins(
  api: Api,
  built: BuiltBudget[],
): Promise<void> {
  for (const b of built) {
    const team = b.team;
    const monthName = monthLabel(b.result.month, b.result.year);
    const gamesLine = b.gamesCount > 0 ? ` Учтено игр: ${b.gamesCount}.` : '';
    // Первое сообщение — инфо/инструкция (отдельно от самого драфта).
    const info =
      `✅ <b>Черновик бюджета ${team} за ${monthName}</b>\n` +
      `Базовый взнос ${b.result.base_per_person}₽ × ${b.result.charges.length} чел.${gamesLine}\n` +
      `Проверь черновик ниже и нажми «Опубликовать в чат».`;
    const keyboard = draftKeyboard(b.budgetId, team);
    for (const adminId of env.ADMIN_TG_IDS) {
      const warn = (err: unknown) =>
        log.warn(
          `[notify] не удалось отправить черновик админу ${adminId} (нажал ли он Start у бота?)`,
          (err as Error).message,
        );
      await api
        .sendMessage(adminId, info, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        .catch(warn);
      // Второе сообщение — сам драфт сбора, с кнопкой публикации.
      await api
        .sendMessage(adminId, b.message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        })
        .catch(warn);
    }
  }
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

/**
 * Уведомление в чаты обеих команд, что состав участников бюджета на следующий
 * месяц зафиксирован (шлём за сутки до рассылки сбора — см. cron).
 */
export async function sendBudgetFixationNotice(api: Api): Promise<void> {
  const { month, year } = nextMonthOf(new Date());
  const text = `🔒 <b>Участники бюджета на ${monthLabel(month, year)} зафиксированы.</b>`;
  for (const team of TEAMS) {
    const chat = env.chats[team];
    await api
      .sendMessage(chat.chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
      })
      .catch((err) =>
        log.warn(`[notify] не удалось отправить уведомление о фиксации (${team})`, (err as Error).message),
      );
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
