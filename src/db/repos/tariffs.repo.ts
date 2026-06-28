import { query } from '../pool.js';
import type { Tariffs } from '../types.js';

export async function getTariffs(): Promise<Tariffs> {
  const { rows } = await query<Tariffs>(
    `select coach_per_session, coach_per_game, gym_paid_price, locker_rent_price, referee_default
     from tariffs where id = 1`,
  );
  if (!rows[0]) throw new Error('Тарифы не инициализированы — запусти миграции');
  return rows[0];
}

export async function updateTariffs(t: Partial<Tariffs>): Promise<Tariffs> {
  const { rows } = await query<Tariffs>(
    `update tariffs set
       coach_per_session = coalesce($1, coach_per_session),
       coach_per_game    = coalesce($2, coach_per_game),
       gym_paid_price    = coalesce($3, gym_paid_price),
       locker_rent_price = coalesce($4, locker_rent_price),
       referee_default   = coalesce($5, referee_default),
       updated_at = now()
     where id = 1
     returning coach_per_session, coach_per_game, gym_paid_price, locker_rent_price, referee_default`,
    [
      t.coach_per_session ?? null,
      t.coach_per_game ?? null,
      t.gym_paid_price ?? null,
      t.locker_rent_price ?? null,
      t.referee_default ?? null,
    ],
  );
  return rows[0]!;
}
