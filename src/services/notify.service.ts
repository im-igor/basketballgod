import { InlineKeyboard, type Api } from 'grammy';
import { env, TEAMS } from '../config/env.js';
import {
  getBudgetById,
  getCharges,
  getDebtors,
  setBudgetMessage,
} from '../db/repos/budgets.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { buildBudgetMessage, buildDebtorsMessage, type ChargeView } from '../domain/messages.js';
import { monthLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';
import type { BudgetDetails, Team } from '../db/types.js';
import type { BuiltBudget } from './budget.service.js';

const payment = { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL };

/** Собрать текст сообщения сбора из сохранённого бюджета (с пометками оплат). */
export async function renderBudgetFromDb(budgetId: number): Promise<{
  team: Team;
  chatId: number | null;
  messageId: number | null;
  text: string;
} | null> {
  const budget = await getBudgetById(budgetId);
  if (!budget || !budget.details) return null;
  const [charges, tariffs] = await Promise.all([getCharges(budgetId), getTariffs()]);
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
  built: Record<Team, BuiltBudget>,
): Promise<void> {
  for (const team of TEAMS) {
    const b = built[team];
    const header =
      `🧾 <b>Черновик бюджета — ${team}</b>\n` +
      `Проверь и нажми «Опубликовать», чтобы бот отправил сбор в чат команды.\n\n`;
    const keyboard = new InlineKeyboard().text(
      `✅ Опубликовать в чат ${team}`,
      `budpub:${b.budgetId}`,
    );
    for (const adminId of env.ADMIN_TG_IDS) {
      await api
        .sendMessage(adminId, header + b.message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        })
        .catch((err) =>
          log.warn(
            `[notify] не удалось отправить черновик админу ${adminId} (нажал ли он Start у бота?)`,
            (err as Error).message,
          ),
        );
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

/** Отправить напоминание должникам команды за месяц. */
export async function sendDebtors(
  api: Api,
  budgetId: number,
): Promise<{ count: number }> {
  const budget = await getBudgetById(budgetId);
  if (!budget) throw new Error(`Бюджет #${budgetId} не найден`);
  const debtors = await getDebtors(budgetId);
  if (debtors.length === 0) return { count: 0 };

  const text = buildDebtorsMessage(
    monthLabel(budget.month, budget.year),
    debtors.map((d) => ({ name: d.name, tg_login: d.tg_login, amount: d.amount })),
    payment,
  );
  const chat = env.chats[budget.team];
  await api.sendMessage(chat.chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
  });
  return { count: debtors.length };
}
