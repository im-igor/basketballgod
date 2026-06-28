import { InlineKeyboard, type Bot } from 'grammy';
import { isAdmin } from './middlewares/auth.js';
import {
  getBudget,
  getBudgetById,
  getDebtors,
  setChargePaid,
} from '../db/repos/budgets.repo.js';
import { refreshBudgetMessage } from '../services/notify.service.js';
import { monthLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

/** Полное ФИО → «Имя Отчество Ф.» (хранение: «Фамилия Имя Отчество»). */
export function formatNameForButton(name: string | null): string {
  const t = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (t.length >= 3) return `${t[1]} ${t[2]} ${t[0]![0]}.`;
  if (t.length === 2) return `${t[1]} ${t[0]![0]}.`;
  return name ?? 'без имени';
}

/**
 * Промпт «кого отметить оплатившим» за месяц: кнопки с именами должников ОБЕИХ команд
 * (только неоплатившие). `undoChargeId` — id последней отмеченной оплаты для кнопки отмены.
 */
export async function buildPayPrompt(
  month: number,
  year: number,
  undoChargeId?: number,
): Promise<{ text: string; keyboard?: InlineKeyboard; hasBudget: boolean }> {
  let hasBudget = false;
  const buttons: { id: number; label: string }[] = [];

  for (const team of TEAMS) {
    const budget = await getBudget(team, month, year);
    if (!budget) continue;
    hasBudget = true;
    const debtors = await getDebtors(budget.id);
    for (const c of debtors) buttons.push({ id: c.id, label: formatNameForButton(c.name) });
  }

  // Единый список обеих команд по алфавиту (по подписи «Имя …») по возрастанию.
  buttons.sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.label, `paymark:${b.id}`).row();
  const unpaidCount = buttons.length;

  if (undoChargeId) kb.text('↩️ Отменить последнюю отметку', `payundo:${undoChargeId}`).row();

  const label = monthLabel(month, year);
  const text =
    unpaidCount > 0
      ? `💳 Кого отметить оплатившим за ${label} (показаны только должники):`
      : `✅ За ${label} оплатили все.`;
  const keyboard = unpaidCount > 0 || undoChargeId ? kb : undefined;
  return { text, keyboard, hasBudget };
}

export function registerPayMark(bot: Bot): void {
  // Отметить оплату по нажатию имени
  bot.callbackQuery(/^paymark:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const chargeId = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const charge = await setChargePaid(chargeId, true);
      if (!charge) {
        await ctx.answerCallbackQuery({ text: 'Начисление не найдено', show_alert: true });
        return;
      }
      await refreshBudgetMessage(ctx.api, charge.budget_id).catch(() => undefined);
      const budget = await getBudgetById(charge.budget_id);
      if (budget) {
        const { text, keyboard } = await buildPayPrompt(budget.month, budget.year, chargeId);
        await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => undefined);
      }
      await ctx.answerCallbackQuery({ text: `✅ Отмечен: ${formatNameForButton(charge.name)}` });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });

  // Отмена последней отметки
  bot.callbackQuery(/^payundo:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const chargeId = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const charge = await setChargePaid(chargeId, false);
      if (!charge) {
        await ctx.answerCallbackQuery({ text: 'Начисление не найдено', show_alert: true });
        return;
      }
      await refreshBudgetMessage(ctx.api, charge.budget_id).catch(() => undefined);
      const budget = await getBudgetById(charge.budget_id);
      if (budget) {
        const { text, keyboard } = await buildPayPrompt(budget.month, budget.year);
        await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => undefined);
      }
      await ctx.answerCallbackQuery({ text: `↩️ Отменено: ${formatNameForButton(charge.name)}` });
    } catch (err) {
      log.error('[pay-mark] ошибка отмены', (err as Error).message);
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });
}
