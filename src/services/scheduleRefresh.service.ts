import {
  getScheduleSource,
  listScheduleSources,
  recordScheduleSourceCheck,
} from '../db/repos/scheduleSources.repo.js';
import type { ScheduleSource, Team } from '../db/types.js';
import { importSchedule, type ScheduleImportResult } from './scheduleImport.service.js';

export interface ScheduleRefreshResult extends ScheduleImportResult {
  source: ScheduleSource;
  team: Team;
  ok: boolean;
}

const runningBySource = new Map<ScheduleSource, Promise<ScheduleRefreshResult>>();

/** Проверить один сохранённый источник. Ошибка фиксируется в БД и возвращается в результате. */
export async function refreshScheduleSource(
  source: ScheduleSource,
  importer: typeof importSchedule = importSchedule,
): Promise<ScheduleRefreshResult> {
  const running = runningBySource.get(source);
  if (running) return running;
  const task = runScheduleSourceRefresh(source, importer);
  runningBySource.set(source, task);
  try {
    return await task;
  } finally {
    if (runningBySource.get(source) === task) runningBySource.delete(source);
  }
}

async function runScheduleSourceRefresh(
  source: ScheduleSource,
  importer: typeof importSchedule,
): Promise<ScheduleRefreshResult> {
  const config = await getScheduleSource(source);
  if (!config) throw new Error(`Источник ${source} не настроен`);
  try {
    const result = await importer(config.team, config.url);
    const error = result.errors.length > 0 ? result.errors.join('; ').slice(0, 2000) : null;
    await recordScheduleSourceCheck({
      source,
      success: error === null,
      found: result.found,
      newGames: result.newGames,
      saved: result.saved,
      calendarSynced: result.calendarSynced,
      error,
    });
    return { source, team: config.team, ok: error === null, ...result };
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000);
    await recordScheduleSourceCheck({
      source,
      success: false,
      found: 0,
      newGames: 0,
      saved: 0,
      calendarSynced: 0,
      error: message,
    });
    return {
      source,
      team: config.team,
      ok: false,
      found: 0,
      newGames: 0,
      saved: 0,
      calendarSynced: 0,
      errors: [message],
    };
  }
}

let refreshRunning = false;

/** Последовательно проверить все включённые источники, не создавая параллельную нагрузку на лиги. */
export async function refreshConfiguredSchedules(): Promise<ScheduleRefreshResult[]> {
  if (refreshRunning) return [];
  refreshRunning = true;
  try {
    const results: ScheduleRefreshResult[] = [];
    for (const source of await listScheduleSources(true)) {
      results.push(await refreshScheduleSource(source.source));
    }
    return results;
  } finally {
    refreshRunning = false;
  }
}
