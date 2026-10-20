import { query } from '../pool.js';
import type { MonthlyPayout } from '../types.js';

export type MonthlyPayoutInput = Omit<MonthlyPayout, 'calculated_at' | 'notified_at'>;

/** Сохранить первый итоговый снимок месяца; повторный запуск его не меняет. */
export async function saveMonthlyPayout(input: MonthlyPayoutInput): Promise<MonthlyPayout> {
  const { rows } = await query<MonthlyPayout>(
    `insert into monthly_payouts (
       month, year, coach_amount, gym_amount, coach_training_sessions, coach_games,
       paid_gym_sessions, coach_per_session, coach_per_game, gym_paid_price, locker_rent_price,
       coach_items, gym_items, corrections
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (year, month) do nothing
     returning *`,
    [
      input.month,
      input.year,
      input.coach_amount,
      input.gym_amount,
      input.coach_training_sessions,
      input.coach_games,
      input.paid_gym_sessions,
      input.coach_per_session,
      input.coach_per_game,
      input.gym_paid_price,
      input.locker_rent_price,
      JSON.stringify(input.coach_items),
      JSON.stringify(input.gym_items),
      JSON.stringify(input.corrections ?? []),
    ],
  );
  if (rows[0]) return rows[0];
  const existing = await getMonthlyPayout(input.month, input.year);
  if (!existing) throw new Error(`Не удалось сохранить расчёт за ${input.month}.${input.year}`);
  return existing;
}

export async function getMonthlyPayout(month: number, year: number): Promise<MonthlyPayout | null> {
  const { rows } = await query<MonthlyPayout>(
    'select * from monthly_payouts where month = $1 and year = $2',
    [month, year],
  );
  return rows[0] ?? null;
}

export async function listMonthlyPayouts(): Promise<MonthlyPayout[]> {
  const { rows } = await query<MonthlyPayout>(
    'select * from monthly_payouts order by year desc, month desc',
  );
  return rows;
}

export async function markMonthlyPayoutNotified(month: number, year: number): Promise<void> {
  await query(
    'update monthly_payouts set notified_at = now() where month = $1 and year = $2',
    [month, year],
  );
}
