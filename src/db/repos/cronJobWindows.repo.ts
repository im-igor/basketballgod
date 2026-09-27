import { query } from '../pool.js';

export type CronJobKey = 'game-polls';

export interface CronJobWindow {
  job_key: CronJobKey;
  window_started_at: string | Date;
  window_until: string | Date;
  completed_at: string | Date | null;
  updated_at: string | Date;
}

/** Начать новое окно. completed_at сбрасывается, чтобы парсер не работал поверх незавершённого cron. */
export async function beginCronJobWindow(
  jobKey: CronJobKey,
  startedAt: Date,
  until: Date,
): Promise<void> {
  await query(
    `insert into cron_job_windows (job_key, window_started_at, window_until, completed_at)
     values ($1,$2,$3,null)
     on conflict (job_key) do update set
       window_started_at = excluded.window_started_at,
       window_until = excluded.window_until,
       completed_at = null,
       updated_at = now()`,
    [jobKey, startedAt, until],
  );
}

/** Завершить только тот запуск, который начал данное окно. */
export async function completeCronJobWindow(jobKey: CronJobKey, startedAt: Date): Promise<void> {
  await query(
    `update cron_job_windows set completed_at = now(), updated_at = now()
     where job_key = $1 and window_started_at = $2`,
    [jobKey, startedAt],
  );
}

export async function getCronJobWindow(jobKey: CronJobKey): Promise<CronJobWindow | null> {
  const { rows } = await query<CronJobWindow>(
    'select * from cron_job_windows where job_key = $1',
    [jobKey],
  );
  return rows[0] ?? null;
}
