import {
  getScheduleSource,
  listScheduleSources,
  recordScheduleSourceCheck,
} from '../db/repos/scheduleSources.repo.js';
import type { ScheduleSource, Team } from '../db/types.js';
import type { Api } from 'grammy';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
import { importSchedule, type ScheduleImportResult } from './scheduleImport.service.js';
import { sendPendingScheduledGamePolls } from './schedulePoll.service.js';

export interface ScheduleRefreshResult extends ScheduleImportResult {
  source: ScheduleSource;
  team: Team;
  ok: boolean;
  pollsSent: number;
  pollsAlreadySent: number;
  pollErrors: string[];
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
    return {
      source,
      team: config.team,
      ok: error === null,
      pollsSent: 0,
      pollsAlreadySent: 0,
      pollErrors: [],
      ...result,
    };
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
      pollsSent: 0,
      pollsAlreadySent: 0,
      pollErrors: [],
    };
  }
}

/** Проверить источник и, если настройка включена, разослать ожидающие опросы новых игр. */
export async function refreshScheduleSourceWithPolls(
  api: Api,
  source: ScheduleSource,
  importer: typeof importSchedule = importSchedule,
): Promise<ScheduleRefreshResult> {
  const result = await refreshScheduleSource(source, importer);
  const config = await getCronConfig();
  if (!config.schedule_import_send_polls) return result;
  const polls = await sendPendingScheduledGamePolls(api, source);
  return {
    ...result,
    pollsSent: polls.sent,
    pollsAlreadySent: polls.alreadySent,
    pollErrors: polls.errors,
  };
}

let refreshRunning = false;

/** Последовательно проверить все включённые источники, не создавая параллельную нагрузку на лиги. */
export async function refreshConfiguredSchedules(api?: Api): Promise<ScheduleRefreshResult[]> {
  if (refreshRunning) return [];
  refreshRunning = true;
  try {
    const results: ScheduleRefreshResult[] = [];
    for (const source of await listScheduleSources(true)) {
      results.push(api
        ? await refreshScheduleSourceWithPolls(api, source.source)
        : await refreshScheduleSource(source.source));
    }
    return results;
  } finally {
    refreshRunning = false;
  }
}
