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

export interface GameView {
  played_on: string | Date | null; // ISO-строка или Date из БД (колонка date)
  opponent: string | null;
  fee_per_player: number | null;
}

export interface BudgetMessageInput {
  team: Team;
  month: number;
  year: number;
  details: BudgetDetails;
  tariffs: Tariffs;
  charges: ChargeView[];
  games: GameView[];
  payment: { sberUrl: string; tbankUrl: string };
}

/** ISO YYYY-MM-DD или Date (колонка date) → ДД.ММ.ГГГГ; пусто, если нет. */
function isoToRu(v: string | Date | null): string {
  if (!v) return '';
  if (v instanceof Date) {
    const d = String(v.getDate()).padStart(2, '0');
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    return `${d}.${mo}.${v.getFullYear()}`;
  }
  const m = v.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
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

  const gamesBlock =
    input.games.length > 0
      ? `За прошедшие игры прибавляю участвовавшим:\n` +
        input.games
          .map((g) => {
            const date = isoToRu(g.played_on);
            const opp = escapeHtml(g.opponent ?? 'игра');
            return `${date ? `${date} ` : ''}${opp} +${g.fee_per_player ?? 0}`;
          })
          .join('\n') +
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
