import { query } from '../pool.js';
import type { ScheduledGame, ScheduleSource, Team } from '../types.js';

export interface ScheduledGameInput {
  source: ScheduleSource;
  source_url: string;
  external_id: string;
  team: Team;
  team_a: string;
  team_b: string;
  game_date: string;
  game_time: string | null;
  location: string | null;
  details_url: string | null;
}

/** Повторный импорт обновляет время/место/команды, но сохраняет связь с Google Calendar. */
export async function upsertScheduledGame(g: ScheduledGameInput): Promise<ScheduledGame> {
  const { rows } = await query<ScheduledGame>(
    `insert into scheduled_games
       (source, source_url, external_id, team, team_a, team_b, game_date, game_time, location, details_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (source, external_id) do update set
       source_url = excluded.source_url,
       team = excluded.team,
       team_a = excluded.team_a,
       team_b = excluded.team_b,
       game_date = excluded.game_date,
       game_time = excluded.game_time,
       location = excluded.location,
       details_url = excluded.details_url,
       updated_at = now()
     returning *`,
    [
      g.source,
      g.source_url,
      g.external_id,
      g.team,
      g.team_a,
      g.team_b,
      g.game_date,
      g.game_time,
      g.location,
      g.details_url,
    ],
  );
  return rows[0]!;
}

export async function setScheduledGameCalendarEventId(id: string, calendarEventId: string): Promise<void> {
  await query(
    'update scheduled_games set calendar_event_id = $2, updated_at = now() where id = $1',
    [id, calendarEventId],
  );
}

export async function listScheduledGames(limit = 250): Promise<ScheduledGame[]> {
  const { rows } = await query<ScheduledGame>(
    `select * from scheduled_games
     order by game_date desc, game_time desc nulls last, id desc
     limit $1`,
    [limit],
  );
  return rows;
}

export async function getScheduledGameById(id: string): Promise<ScheduledGame | null> {
  const { rows } = await query<ScheduledGame>('select * from scheduled_games where id = $1', [id]);
  return rows[0] ?? null;
}

export async function getScheduledGameByExternalId(
  source: ScheduleSource,
  externalId: string,
): Promise<ScheduledGame | null> {
  const { rows } = await query<ScheduledGame>(
    'select * from scheduled_games where source = $1 and external_id = $2',
    [source, externalId],
  );
  return rows[0] ?? null;
}

export async function findScheduledGameForManualEntry(
  team: Team,
  gameDate: string,
  opponent: string,
): Promise<ScheduledGame | null> {
  const { rows } = await query<ScheduledGame>(
    `select * from scheduled_games
     where team = $1 and game_date = $2
       and (
         lower(trim(team_a)) = lower(trim($3)) or
         lower(trim(team_b)) = lower(trim($3))
       )
     order by id desc limit 1`,
    [team, gameDate, opponent],
  );
  return rows[0] ?? null;
}

export async function setScheduledGameCoachPresent(
  id: string,
  present: boolean | null,
  manual = true,
): Promise<ScheduledGame | null> {
  const { rows } = await query<ScheduledGame>(
    `update scheduled_games set coach_present = $2, coach_override = $3, updated_at = now()
     where id = $1 returning *`,
    [id, present, manual && present !== null],
  );
  return rows[0] ?? null;
}

/** Матчи, пересекающиеся по времени. ЛЧБ занимает 80 минут, МЛБЛ — 90 минут. */
export async function listOverlappingScheduledGames(id: string): Promise<ScheduledGame[]> {
  const { rows } = await query<ScheduledGame>(
    `select other.*
     from scheduled_games target
     join scheduled_games other on other.id <> target.id
      and target.game_time is not null and other.game_time is not null
      and (target.game_date + target.game_time) <
          (other.game_date + other.game_time + case other.source when 'LCHB' then interval '80 minutes' else interval '90 minutes' end)
      and (other.game_date + other.game_time) <
          (target.game_date + target.game_time + case target.source when 'LCHB' then interval '80 minutes' else interval '90 minutes' end)
     where target.id = $1
     order by other.game_date, other.game_time`,
    [id],
  );
  return rows;
}

/** Пересчитать флаг конфликтов и вернуть только строки, у которых он изменился. */
export async function recomputeScheduleConflicts(): Promise<ScheduledGame[]> {
  const { rows } = await query<ScheduledGame>(
    `with state as (
       select target.id,
         exists (
           select 1 from scheduled_games other
           where other.id <> target.id
             and target.game_time is not null and other.game_time is not null
             and (target.game_date + target.game_time) <
                 (other.game_date + other.game_time + case other.source when 'LCHB' then interval '80 minutes' else interval '90 minutes' end)
             and (other.game_date + other.game_time) <
                 (target.game_date + target.game_time + case target.source when 'LCHB' then interval '80 minutes' else interval '90 minutes' end)
         ) as conflicts
       from scheduled_games target
     )
     update scheduled_games game
     set coach_conflict = state.conflicts,
         coach_present = case
           when state.conflicts = false and game.coach_override = false then null
           else game.coach_present
         end,
         updated_at = now()
     from state
     where game.id = state.id and (
       game.coach_conflict is distinct from state.conflicts or
       (state.conflicts = false and game.coach_override = false and game.coach_present is not null)
     )
     returning game.*`,
  );
  return rows;
}
