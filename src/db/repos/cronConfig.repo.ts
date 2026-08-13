import { query } from '../pool.js';
import type { CronConfig } from '../types.js';

const COLUMNS = `timezone,
       poll_training_weekday, poll_training_time, poll_training_horizon_days,
       poll_game_weekday, poll_game_time, poll_game_horizon_days,
       fixation_day, fixation_time, budget_day, budget_time`;

/** Расписание планировщика — singleton-строка (id=1). */
export async function getCronConfig(): Promise<CronConfig> {
  const { rows } = await query<CronConfig>(
    `select ${COLUMNS} from cron_config where id = 1`,
  );
  if (!rows[0]) throw new Error('cron_config не инициализирован — запусти миграции');
  return rows[0];
}

/** Обновить конфиг расписания; undefined-поля сохраняют текущее значение (coalesce). */
export async function updateCronConfig(c: Partial<CronConfig>): Promise<CronConfig> {
  const { rows } = await query<CronConfig>(
    `update cron_config set
       timezone                   = coalesce($1, timezone),
       poll_training_weekday      = coalesce($2, poll_training_weekday),
       poll_training_time         = coalesce($3, poll_training_time),
       poll_training_horizon_days = coalesce($4, poll_training_horizon_days),
       poll_game_weekday          = coalesce($5, poll_game_weekday),
       poll_game_time             = coalesce($6, poll_game_time),
       poll_game_horizon_days     = coalesce($7, poll_game_horizon_days),
       fixation_day               = coalesce($8, fixation_day),
       fixation_time              = coalesce($9, fixation_time),
       budget_day                 = coalesce($10, budget_day),
       budget_time                = coalesce($11, budget_time),
       updated_at = now()
     where id = 1
     returning ${COLUMNS}`,
    [
      c.timezone ?? null,
      c.poll_training_weekday ?? null,
      c.poll_training_time ?? null,
      c.poll_training_horizon_days ?? null,
      c.poll_game_weekday ?? null,
      c.poll_game_time ?? null,
      c.poll_game_horizon_days ?? null,
      c.fixation_day ?? null,
      c.fixation_time ?? null,
      c.budget_day ?? null,
      c.budget_time ?? null,
    ],
  );
  return rows[0]!;
}
