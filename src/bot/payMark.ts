import { InlineKeyboard, type Bot } from 'grammy';
import { isAdmin } from './middlewares/auth.js';
import {
  getBudget,
  getBudgetById,
  getCharges,
  toggleChargePaid,
} from '../db/repos/budgets.repo.js';
import { refreshBudgetMessage } from '../services/notify.service.js';
import { formatFullName } from '../domain/messages.js';
import { monthLabel } from '../domain/dates.js';
import type { Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

/**
 * Промпт оплат за месяц: кнопки со ВСЕМИ игроками обеих команд, у оплативших — ✅.
 * Нажатие переключает статус (см. paymark), кнопки не пропадают.
 */
export async function buildPayPrompt(
  month: number,
  year: number,
): Promise<{ text: string; keyboard?: InlineKeyboard; hasBudget: boolean }> {
  let hasBudget = false;
  const buttons: { id: number; label: string; paid: boolean }[] = [];
  let paidCount = 0;

  for (const team of TEAMS) {
    const budget = await getBudget(team, month, year);
    if (!budget) continue;
    hasBudget = true;
    const charges = await getCharges(budget.id);
    for (const c of charges) {
      // Кнопка: «Имя Отчество Фамилия <сумма к оплате за месяц>», напр. «Иван Петрович Сидоров 4250».
      const label = `${formatFullName(c.name) || 'без имени'} ${Math.round(Number(c.amount))}`;
      buttons.push({ id: c.id, label, paid: c.paid });
      if (c.paid) paidCount++;
    }
  }

  // Единый список обеих команд по алфавиту (по подписи «Имя …») по возрастанию.
  buttons.sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(`${b.paid ? '✅ ' : ''}${b.label}`, `paymark:${b.id}`).row();

  const label = monthLabel(month, year);
  const total = buttons.length;
  const text =
    total > 0
      ? `💳 Оплаты за ${label} — нажми на имя, чтобы переключить (✅ = оплатил).\n` +
        `Оплатили ${paidCount} из ${total}.`
      : `За ${label} начислений нет.`;
  const keyboard = total > 0 ? kb : undefined;
  return { text, keyboard, hasBudget };
}

export function registerPayMark(bot: Bot): void {
  // Переключить статус оплаты по нажатию имени (не оплатил ↔ оплатил).
  bot.callbackQuery(/^paymark:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const chargeId = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const charge = await toggleChargePaid(chargeId);
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
      const name = formatFullName(charge.name) || 'без имени';
      await ctx.answerCallbackQuery({ text: charge.paid ? `✅ Оплатил: ${name}` : `↩️ Снято: ${name}` });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });
}
