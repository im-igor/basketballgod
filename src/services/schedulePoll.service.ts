import type { Api } from 'grammy';
import type { ScheduleSource, ScheduledGame } from '../db/types.js';
import {
  listPendingScheduledGamePolls,
  recordScheduledGamePollResult,
} from '../db/repos/scheduledGames.repo.js';
import { sendGamePollForEvent } from './poll.service.js';
import { getCronJobWindow } from '../db/repos/cronJobWindows.repo.js';

export interface SchedulePollDispatchResult {
  sent: number;
  alreadySent: number;
  deferred: number;
  errors: string[];
}

function gameDate(game: ScheduledGame): string {
  return game.game_date instanceof Date
    ? game.game_date.toISOString().slice(0, 10)
    : String(game.game_date).slice(0, 10);
}

function gameStart(game: ScheduledGame): { start: string; startDateTime: boolean } {
  const date = gameDate(game);
  const time = game.game_time ? String(game.game_time).slice(0, 5) : null;
  if (!time) return { start: date, startDateTime: false };
  return { start: new Date(`${date}T${time}:00+03:00`).toISOString(), startDateTime: true };
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function gameStartsAt(game: ScheduledGame): Date {
  const date = gameDate(game);
  const time = game.game_time ? String(game.game_time).slice(0, 5) : '00:00';
  return new Date(`${date}T${time}:00+03:00`);
}

function isInCompletedActiveWindow(
  game: ScheduledGame,
  window: Awaited<ReturnType<typeof getCronJobWindow>>,
  now: Date,
): boolean {
  if (!window?.completed_at) return false;
  const startedAt = asDate(window.window_started_at);
  const until = asDate(window.window_until);
  const discoveredAt = asDate(game.created_at);
  const startsAt = gameStartsAt(game);
  return now < until
    && discoveredAt >= startedAt
    && startsAt >= startedAt
    && startsAt < until;
}

/**
 * Отправить голосовалки игр, обнаруженных после последнего планового cron и попавших
 * в его активный интервал. Остальные остаются в очереди до следующего окна.
 */
export async function sendPendingScheduledGamePolls(
  api: Api,
  source?: ScheduleSource,
): Promise<SchedulePollDispatchResult> {
  const result: SchedulePollDispatchResult = { sent: 0, alreadySent: 0, deferred: 0, errors: [] };
  const [games, window] = await Promise.all([
    listPendingScheduledGamePolls(source),
    getCronJobWindow('game-polls'),
  ]);
  const now = new Date();
  for (const game of games) {
    if (!isInCompletedActiveWindow(game, window, now)) {
      result.deferred++;
      continue;
    }
    try {
      const start = gameStart(game);
      const sent = await sendGamePollForEvent(api, {
        uid: game.calendar_event_id!,
        team: game.team,
        summary: `Игра ${game.team_a} - ${game.team_b}`,
        location: game.location,
        ...start,
      });
      await recordScheduledGamePollResult(game.id, true);
      if (sent.sent) result.sent++;
      else result.alreadySent++;
    } catch (err) {
      const message = (err as Error).message.slice(0, 2000);
      await recordScheduledGamePollResult(game.id, false, message);
      result.errors.push(`${game.team_a} — ${game.team_b}: ${message}`);
    }
  }
  return result;
}
