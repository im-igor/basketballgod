import { query } from '../pool.js';
import type { CronConfig } from '../types.js';

/** Расписание планировщика — singleton-строка (id=1). */
export async function getCronConfig(): Promise<CronConfig> {
  const { rows } = await query<CronConfig>(
    `select timezone, poll_weekday, poll_time, fixation_day, fixation_time, budget_day, budget_time
     from cron_config where id = 1`,
  );
  if (!rows[0]) throw new Error('cron_config не инициализирован — запусти миграции');
  return rows[0];
}

/** Обновить конфиг расписания; undefined-поля сохраняют текущее значение (coalesce). */
export async function updateCronConfig(c: Partial<CronConfig>): Promise<CronConfig> {
  const { rows } = await query<CronConfig>(
    `update cron_config set
       timezone      = coalesce($1, timezone),
       poll_weekday  = coalesce($2, poll_weekday),
       poll_time     = coalesce($3, poll_time),
       fixation_day  = coalesce($4, fixation_day),
       fixation_time = coalesce($5, fixation_time),
       budget_day    = coalesce($6, budget_day),
       budget_time   = coalesce($7, budget_time),
       updated_at = now()
     where id = 1
     returning timezone, poll_weekday, poll_time, fixation_day, fixation_time, budget_day, budget_time`,
    [
      c.timezone ?? null,
      c.poll_weekday ?? null,
      c.poll_time ?? null,
      c.fixation_day ?? null,
      c.fixation_time ?? null,
      c.budget_day ?? null,
      c.budget_time ?? null,
    ],
  );
  return rows[0]!;
}
