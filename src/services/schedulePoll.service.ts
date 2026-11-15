import { inActivePollWindowForStart } from '../domain/pollSchedule.js';
import type { Api } from 'grammy';
import type { ScheduledGameSource } from '../db/types.js';
import {
  listPendingScheduledGamePolls,
  recordScheduledGamePollResult,
} from '../db/repos/scheduledGames.repo.js';
import { sendGamePollForEvent } from './poll.service.js';
import { getCronJobWindow } from '../db/repos/cronJobWindows.repo.js';
import {
  createGamePollFreshnessContext,
  readFreshCalendarGameForPoll,
  type GamePollFreshnessContext,
} from './gamePollFreshness.service.js';
import type { CalendarEvent } from '../google/calendar.js';

export interface SchedulePollDispatchResult {
  sent: number;
  alreadySent: number;
  deferred: number;
  errors: string[];
}

type FreshGameReader = (
  team: CalendarEvent['team'],
  eventId: string,
  context: GamePollFreshnessContext,
) => Promise<CalendarEvent>;

/**
 * Отправить голосовалки игр, обнаруженных после последнего планового cron и попавших
 * в его активный интервал. Остальные остаются в очереди до следующего окна.
 */
export async function sendPendingScheduledGamePolls(
  api: Api,
  source?: ScheduledGameSource,
  readFreshGame: FreshGameReader = readFreshCalendarGameForPoll,
): Promise<SchedulePollDispatchResult> {
  const result: SchedulePollDispatchResult = { sent: 0, alreadySent: 0, deferred: 0, errors: [] };
  const [games, window] = await Promise.all([
    listPendingScheduledGamePolls(source),
    getCronJobWindow('game-polls'),
  ]);
  const now = new Date();
  const freshness = createGamePollFreshnessContext();
  for (const game of games) {
    try {
      const event = await readFreshGame(game.team, game.calendar_event_id!, freshness);
      if (!inActivePollWindowForStart(game.created_at, new Date(event.start), window, now)) {
        result.deferred++;
        continue;
      }
      const sent = await sendGamePollForEvent(api, event);
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
