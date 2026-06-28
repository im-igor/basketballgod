import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listEvents, type CalendarEvent } from '../google/calendar.js';
import { savePollSession } from '../db/repos/polls.repo.js';
import { eventLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];
const other = (t: Team): Team => (t === 'RED' ? 'BLACK' : 'RED');

function questionFor(ev: CalendarEvent): string {
  const when = eventLabel(ev.start, ev.startDateTime);
  const loc = ev.location ? ` [${ev.location}]` : '';
  return `${ev.summary} ${when}${loc}`.slice(0, 300); // лимит вопроса опроса Telegram
}

/**
 * Разослать опросы по событиям на ближайшие POLL_HORIZON_DAYS дней.
 * Тренировки (TYPE=TRAINING) дублируются (forward) в чат другой команды —
 * игроки могут посещать оба зала.
 */
export async function sendWeeklyPolls(api: Api): Promise<{ sent: number; forwarded: number }> {
  const now = new Date();
  const horizonMs = env.POLL_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const timeMax = new Date(now.getTime() + horizonMs);

  let sent = 0;
  let forwarded = 0;

  for (const team of TEAMS) {
    let events: CalendarEvent[];
    try {
      events = await listEvents(team, now, timeMax);
    } catch (err) {
      log.error(`[polls] не удалось прочитать календарь ${team}`, (err as Error).message);
      continue;
    }

    const chat = env.chats[team];
    for (const ev of events) {
      try {
        const msg = await api.sendPoll(
          chat.chatId,
          questionFor(ev),
          env.POLL_OPTIONS.map((text) => ({ text })),
          {
            is_anonymous: false,
            disable_notification: true,
            ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
          },
        );
        sent++;

        if (msg.poll) {
          await savePollSession({
            poll_id: msg.poll.id,
            event_uid: ev.uid,
            team,
            chat_id: chat.chatId,
            message_id: msg.message_id,
            thread_id: chat.threadId ?? null,
            question: questionFor(ev),
            options: env.POLL_OPTIONS,
            event_start: ev.start,
          });
        }

        // Тренировки кросс-постим в чат другой команды.
        if (ev.tags.TYPE === 'TRAINING') {
          const dst = env.chats[other(team)];
          await api.forwardMessage(dst.chatId, chat.chatId, msg.message_id, {
            disable_notification: true,
            ...(dst.threadId ? { message_thread_id: dst.threadId } : {}),
          });
          forwarded++;
        }
      } catch (err) {
        log.error(`[polls] ошибка отправки опроса (${team}: ${ev.summary})`, (err as Error).message);
      }
    }
  }

  log.info(`[polls] отправлено ${sent}, переслано ${forwarded}`);
  return { sent, forwarded };
}
