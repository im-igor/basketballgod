import { query } from '../pool.js';
import type { ScheduleSource, ScheduleSourceConfig, Team } from '../types.js';

export async function listScheduleSources(onlyEnabled = false): Promise<ScheduleSourceConfig[]> {
  const { rows } = await query<ScheduleSourceConfig>(
    `select * from schedule_sources
     where ($1::boolean = false or enabled = true)
     order by case source when 'LCHB' then 1 else 2 end`,
    [onlyEnabled],
  );
  return rows;
}

export async function getScheduleSource(source: ScheduleSource): Promise<ScheduleSourceConfig | null> {
  const { rows } = await query<ScheduleSourceConfig>(
    'select * from schedule_sources where source = $1',
    [source],
  );
  return rows[0] ?? null;
}

/** Смена URL сбрасывает старый статус проверки, чтобы он не вводил администратора в заблуждение. */
export async function upsertScheduleSource(input: {
  source: ScheduleSource;
  team: Team;
  url: string;
  enabled: boolean;
}): Promise<ScheduleSourceConfig> {
  const { rows } = await query<ScheduleSourceConfig>(
    `insert into schedule_sources (source, team, url, enabled)
     values ($1,$2,$3,$4)
     on conflict (source) do update set
       team = excluded.team,
       url = excluded.url,
       enabled = excluded.enabled,
       last_checked_at = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_checked_at end,
       last_success_at = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_success_at end,
       last_found = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_found end,
       last_new = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_new end,
       last_saved = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_saved end,
       last_calendar_synced = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_calendar_synced end,
       last_error = case when schedule_sources.url is distinct from excluded.url then null else schedule_sources.last_error end,
       updated_at = now()
     returning *`,
    [input.source, input.team, input.url, input.enabled],
  );
  return rows[0]!;
}

export async function recordScheduleSourceCheck(input: {
  source: ScheduleSource;
  success: boolean;
  found?: number;
  newGames?: number;
  saved?: number;
  calendarSynced?: number;
  error?: string | null;
}): Promise<void> {
  await query(
    `update schedule_sources set
       last_checked_at = now(),
       last_success_at = case when $2 then now() else last_success_at end,
       last_found = coalesce($3, last_found),
       last_new = coalesce($4, last_new),
       last_saved = coalesce($5, last_saved),
       last_calendar_synced = coalesce($6, last_calendar_synced),
       last_error = $7,
       updated_at = now()
     where source = $1`,
    [input.source, input.success, input.found ?? null, input.newGames ?? null,
      input.saved ?? null, input.calendarSynced ?? null, input.error ?? null],
  );
}
