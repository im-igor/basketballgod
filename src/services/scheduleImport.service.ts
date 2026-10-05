import {
  getScheduledGameById,
  getScheduledGameByExternalId,
  listScheduleDuplicateGroups,
  listOverlappingScheduledGames,
  markScheduleSourcePresence,
  recomputeScheduleConflicts,
  setScheduledGameCoachPresent,
  setScheduledGameCalendarEventId,
  upsertScheduledGame,
} from '../db/repos/scheduledGames.repo.js';
import { upsertScheduledCalendarEvent } from '../google/calendar.js';
import { fetchSchedulePage } from '../schedule/parser.js';
import type { ScheduledGame, Team } from '../db/types.js';
import type { ScheduleDuplicateGroup } from '../domain/schedule.js';

export interface ScheduleImportResult {
  found: number;
  newGames: number;
  saved: number;
  calendarSynced: number;
  errors: string[];
  duplicates?: ScheduleDuplicateGroup[];
}

export async function syncScheduledGame(row: ScheduledGame): Promise<void> {
  const eventId = await upsertScheduledCalendarEvent({
    source: row.source,
    externalId: row.external_id,
    team: row.team,
    teamA: row.team_a,
    teamB: row.team_b,
    gameDate: row.game_date instanceof Date ? row.game_date.toISOString().slice(0, 10) : String(row.game_date).slice(0, 10),
    gameTime: row.game_time ? String(row.game_time).slice(0, 5) : null,
    location: row.location,
    sourceUrl: row.source_url,
    detailsUrl: row.details_url,
    calendarEventId: row.calendar_event_id,
    coachPresent: row.coach_present,
    coachConflict: row.coach_conflict,
  });
  await setScheduledGameCalendarEventId(row.id, eventId);
}

/** Импорт страницы целиком: БД обновляется первой, затем тот же матч синхронизируется в Calendar. */
export async function importSchedule(team: Team, pageUrl: string): Promise<ScheduleImportResult> {
  const parsed = await fetchSchedulePage(pageUrl, team);
  const result: ScheduleImportResult = {
    found: parsed.length,
    newGames: 0,
    saved: 0,
    calendarSynced: 0,
    errors: [],
  };
  const rowsToSync = new Map<string, ScheduledGame>();
  for (const input of parsed) {
    try {
      const existing = await getScheduledGameByExternalId(input.source, input.external_id);
      const row = await upsertScheduledGame(input);
      rowsToSync.set(row.id, row);
      if (!existing) result.newGames++;
      result.saved++;
    } catch (err) {
      result.errors.push(`${input.team_a} — ${input.team_b}: БД: ${(err as Error).message}`);
    }
  }
  const source = parsed[0]!.source;
  await markScheduleSourcePresence(source, team, parsed.map((game) => game.external_id));
  const duplicates = await listScheduleDuplicateGroups(source, team);
  result.duplicates = duplicates;
  const duplicateIds = new Set(duplicates.flatMap((group) => group.games.map((game) => game.id)));
  // Новый матч может сделать конфликтным уже существующий матч другой команды —
  // обновляем в календаре обе стороны пересечения.
  for (const changed of await recomputeScheduleConflicts()) rowsToSync.set(changed.id, changed);
  // После реконсиляции перечитываем импортированные строки, чтобы взять свежий coach_conflict.
  for (const id of [...rowsToSync.keys()]) {
    const fresh = await getScheduledGameById(id);
    if (fresh) rowsToSync.set(id, fresh);
  }
  for (const row of rowsToSync.values()) {
    // Пока администратор не выбрал лишнюю строку, не создаём второй Calendar event и опрос.
    if (duplicateIds.has(row.id)) continue;
    try {
      await syncScheduledGame(row);
      result.calendarSynced++;
    } catch (err) {
      result.errors.push(`${row.team_a} — ${row.team_b}: Google Calendar: ${(err as Error).message}`);
    }
  }
  return result;
}

/** Решение конфликта: назначение тренера на одну игру автоматически снимает его с пересекающихся. */
export async function setScheduleCoachDecision(
  id: string,
  present: boolean | null,
): Promise<{ updated: number }> {
  const target = await setScheduledGameCoachPresent(id, present);
  if (!target) throw new Error('Матч расписания не найден');
  const changed = new Map<string, ScheduledGame>([[target.id, target]]);
  if (present === true) {
    for (const overlap of await listOverlappingScheduledGames(id)) {
      const updated = await setScheduledGameCoachPresent(overlap.id, false, false);
      if (updated) changed.set(updated.id, updated);
    }
  } else if (present === null) {
    // Возврат в «не задано» снимает и прежние автоматические решения у второй стороны.
    for (const overlap of await listOverlappingScheduledGames(id)) {
      if (overlap.coach_override) continue;
      const updated = await setScheduledGameCoachPresent(overlap.id, null, false);
      if (updated) changed.set(updated.id, updated);
    }
  }
  for (const row of changed.values()) await syncScheduledGame(row);
  return { updated: changed.size };
}
