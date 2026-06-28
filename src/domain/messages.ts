import type { BudgetDetails, Tariffs, Team } from '../db/types.js';
import { monthLabel } from './dates.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function paymentBlock(sberUrl: string, tbankUrl: string): string {
  return `Сбер\n${sberUrl}\n\nТбанк\n${tbankUrl}`;
}

export interface ChargeView {
  name: string | null;
  tg_login: string;
  game_amount: number;
  amount: number;
  paid: boolean;
}

export interface BudgetMessageInput {
  team: Team;
  month: number;
  year: number;
  details: BudgetDetails;
  tariffs: Tariffs;
  charges: ChargeView[];
  payment: { sberUrl: string; tbankUrl: string };
}

/**
 * Сообщение сбора в чат команды (HTML parse_mode), формат как в n8n /budget,
 * плюс блок взносов за прошедшие игры и пометки оплат «+».
 */
export function buildBudgetMessage(input: BudgetMessageInput): string {
  const { details: d, tariffs, team } = input;
  const redCount = team === 'RED' ? d.players_team : d.players_other;
  const blackCount = team === 'BLACK' ? d.players_team : d.players_other;
  const label = monthLabel(input.month, input.year);

  const header = `<b>Бюджет ${label} ${team}\n\n</b>`;

  const calc =
    `<blockquote>Всего участников: ${blackCount} Black + ${redCount} Red = ${d.total_players} чел.\n` +
    `Зал PG - ${d.paid_gym_sessions} трен. и оплата шкафчика ${tariffs.locker_rent_price} (делятся на всех)\n` +
    `(${d.paid_gym_sessions} x ${tariffs.gym_paid_price} + ${tariffs.locker_rent_price}) / ${d.total_players} = ${d.gym_per_person} руб.\n` +
    `Зал Red по понедельникам - оплачивается Яндексом полностью.\n` +
    `Тренер в ${team} ${d.coach_sessions} трен. ${d.coach_sessions} x ${tariffs.coach_per_session} / ${d.players_team} = ${d.coach_per_person} руб.\n\n` +
    `ИТОГО: ${d.base_per_person} руб.\n</blockquote>\n`;

  const withGames = input.charges.filter((c) => c.game_amount > 0);
  const gamesBlock =
    withGames.length > 0
      ? `На прошедшие игры прибавляю участвовавшим:\n` +
        withGames.map((c) => `${escapeHtml(c.name ?? '')} +${c.game_amount}`).join('\n') +
        `\n\n`
      : '';

  const usersList = input.charges
    .map((c) => {
      const mark = c.paid ? ' +' : '';
      return `${escapeHtml(c.name ?? '')} ${c.tg_login} ${c.amount}${mark}`;
    })
    .join('\n');

  const pay = paymentBlock(input.payment.sberUrl, input.payment.tbankUrl);
  return `${header}${calc}\n${gamesBlock}${pay}\n\n${usersList}`;
}

/** Сообщение-напоминание должникам за месяц. */
export function buildDebtorsMessage(
  monthName: string,
  debtors: { name: string | null; tg_login: string; amount: number }[],
  payment: { sberUrl: string; tbankUrl: string },
): string {
  const pay = paymentBlock(payment.sberUrl, payment.tbankUrl);
  const list = debtors.map((c) => `${escapeHtml(c.name ?? '')} ${c.tg_login} ${c.amount}`).join('\n');
  return `<b>Просьба должников за ${monthName}</b>\n\n${pay}\n\n${list}`;
}
