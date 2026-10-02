import type { MonthlyPayout, MonthlyPayoutItem, Tariffs, Team } from '../db/types.js';
import { isoToRu, monthLabel } from './dates.js';
import { escapeHtml } from './messages.js';

export interface MonthlyPayouts {
  coach: number;
  gym: number;
  coachTrainingSessions: number;
  coachGames: number;
  paidGymSessions: number;
}

export interface MonthlyPayoutInput {
  coachTrainingSessions: Record<Team, number>;
  coachDeltas?: Partial<Record<Team, number>>;
  coachGames: number;
  paidGymSessions: number;
  tariffs: Tariffs;
}

const money = (value: number): number => Math.round(value * 100) / 100;

/**
 * Суммы к переводу за месяц считаются по стоимости услуг, а не по начислениям
 * игрокам: персональные взносы округляются и могут включать оплату судьи.
 */
export function computeMonthlyPayouts(
  input: MonthlyPayoutInput,
): MonthlyPayouts {
  // Тренировки считаются отдельно для каждой команды. Ручная дельта уже является
  // частью подтверждённого месячного бюджета и ограничивается нулём, как при пересчёте.
  const coachTrainingSessions = (['RED', 'BLACK'] as Team[]).reduce(
    (sum, team) => sum + Math.max(
      0,
      input.coachTrainingSessions[team] + (input.coachDeltas?.[team] ?? 0),
    ),
    0,
  );
  const paidGymSessions = Math.max(0, input.paidGymSessions);
  const normalizedCoachGames = Math.max(0, input.coachGames);

  return {
    coach: money(
      coachTrainingSessions * input.tariffs.coach_per_session +
      normalizedCoachGames * input.tariffs.coach_per_game,
    ),
    gym: money(
      paidGymSessions * input.tariffs.gym_paid_price + input.tariffs.locker_rent_price,
    ),
    coachTrainingSessions,
    coachGames: normalizedCoachGames,
    paidGymSessions,
  };
}

/** Сообщение с зафиксированным месячным расчётом для лички администратора. */
export function buildMonthlyPayoutMessage(payout: MonthlyPayout): string {
  const label = monthLabel(payout.month, payout.year);
  const line = (item: MonthlyPayoutItem): string => {
    const date = item.date ? `${isoToRu(item.date)} · ` : '';
    const team = item.team ? `${item.team} · ` : '';
    return `• ${date}${team}${escapeHtml(item.label)} — ${item.amount} ₽`;
  };

  return `💸 <b>Расчёты за ${label}</b>\n\n` +
    `<b>Тренеру: ${payout.coach_amount} ₽</b>\n` +
    `${payout.coach_items.map(line).join('\n') || '• начислений нет'}\n\n` +
    `<b>Зал: ${payout.gym_amount} ₽</b>\n` +
    `${payout.gym_items.map(line).join('\n') || '• начислений нет'}`;
}
