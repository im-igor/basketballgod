import { getBudget } from '../db/repos/budgets.repo.js';
import { listGamesByPlayedMonth } from '../db/repos/games.repo.js';
import { saveMonthlyPayout } from '../db/repos/monthlyPayouts.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import type { BudgetDetails, MonthlyPayout, MonthlyPayoutItem, Team } from '../db/types.js';
import { computeMonthlyPayouts } from '../domain/payouts.js';
import { monthRange, toISODate } from '../domain/dates.js';
import { listEvents } from '../google/calendar.js';
import { payoutCorrections } from '../domain/budgetCorrections.js';

/** pg возвращает SQL DATE как локальную полночь Date; сохраняем именно календарный день. */
function payoutDate(value: string | Date | null): string | null {
  if (!(value instanceof Date)) return value;
  if (!Number.isFinite(value.getTime())) throw new Error('Некорректная дата игры в расчёте начислений');
  return toISODate(value);
}

/** Предварительный расчёт по текущему календарю без записи в БД. */
export async function calculateMonthlyPayoutPreview(
  month: number,
  year: number,
): Promise<MonthlyPayout> {
  const { from, to } = monthRange(month, year);
  const [tariffs, redEvents, blackEvents, games, redBudget, blackBudget] = await Promise.all([
    getTariffs(),
    listEvents('RED', from, to),
    listEvents('BLACK', from, to),
    listGamesByPlayedMonth(month, year),
    getBudget('RED', month, year),
    getBudget('BLACK', month, year),
  ]);
  const events = [...redEvents, ...blackEvents];
  const trainingEvents = (team: Team) => events.filter(
    (event) => event.team === team && event.tags.TYPE === 'TRAINING' && event.tags.COACH === 'PAID',
  );
  const coachDelta = (details: BudgetDetails | null | undefined) => details?.coach_delta ?? 0;
  const paidGymEvents = new Map(
    events.filter((event) => event.tags.GYM === 'PAID').map((event) => [event.uid, event]),
  );
  const rawCoachDeltas = {
    RED: coachDelta(redBudget?.details),
    BLACK: coachDelta(blackBudget?.details),
  };

  const result = computeMonthlyPayouts({
    coachTrainingSessions: {
      RED: trainingEvents('RED').length,
      BLACK: trainingEvents('BLACK').length,
    },
    coachDeltas: rawCoachDeltas,
    coachGames: games.filter((game) => game.coach_present).length,
    paidGymSessions: paidGymEvents.size,
    tariffs,
  });

  const coachItems: MonthlyPayoutItem[] = (['RED', 'BLACK'] as Team[]).flatMap((team) => {
    const teamEvents = trainingEvents(team);
    const effectiveDelta = Math.max(-teamEvents.length, rawCoachDeltas[team]);
    const items: MonthlyPayoutItem[] = teamEvents.map((event) => ({
      kind: 'TRAINING',
      date: event.start,
      label: event.summary,
      amount: tariffs.coach_per_session,
      team,
    }));
    const budgetDetails = team === 'RED' ? redBudget?.details : blackBudget?.details;
    if (effectiveDelta !== 0) items.push({
      kind: 'ADJUSTMENT',
      date: null,
      label: budgetDetails?.coach_note || `Корректировка тренировок ${team}: ${effectiveDelta > 0 ? '+' : ''}${effectiveDelta}`,
      amount: effectiveDelta * tariffs.coach_per_session,
      team,
    });
    return items;
  });
  coachItems.push(...games.filter((game) => game.coach_present).map((game) => ({
    kind: 'GAME' as const,
    date: payoutDate(game.played_on),
    label: `Игра${game.opponent ? ` с ${game.opponent}` : ''}`,
    amount: tariffs.coach_per_game,
    ...(game.team === 'MIXED' ? {} : { team: game.team }),
  })));
  coachItems.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));

  const gymItems: MonthlyPayoutItem[] = [...paidGymEvents.values()]
    .map((event) => ({
      kind: 'GYM' as const,
      date: event.start,
      label: event.location ? `${event.summary} · ${event.location}` : event.summary,
      amount: tariffs.gym_paid_price,
      team: event.team,
    }))
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  if (tariffs.locker_rent_price !== 0) gymItems.push({
    kind: 'LOCKER',
    date: null,
    label: 'Аренда шкафчика',
    amount: tariffs.locker_rent_price,
  });

  return {
    month,
    year,
    coach_amount: result.coach,
    gym_amount: result.gym,
    coach_training_sessions: result.coachTrainingSessions,
    coach_games: result.coachGames,
    paid_gym_sessions: result.paidGymSessions,
    coach_per_session: tariffs.coach_per_session,
    coach_per_game: tariffs.coach_per_game,
    gym_paid_price: tariffs.gym_paid_price,
    locker_rent_price: tariffs.locker_rent_price,
    coach_items: coachItems,
    gym_items: gymItems,
    corrections: payoutCorrections(redBudget, blackBudget, events, tariffs),
    calculated_at: new Date(),
    notified_at: null,
  };
}

/** Зафиксировать первый итоговый расчёт месяца для постоплаты. */
export async function calculateAndSaveMonthlyPayout(month: number, year: number): Promise<MonthlyPayout> {
  return saveMonthlyPayout(await calculateMonthlyPayoutPreview(month, year));
}
