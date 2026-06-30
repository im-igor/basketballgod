import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listEvents, type CalendarEvent } from '../google/calendar.js';
import { savePollSession } from '../db/repos/polls.repo.js';
import {
  createPollDraft,
  getPollDraft,
  setPollDraftSent,
  type PollDraftRow,
} from '../db/repos/pollDrafts.repo.js';
import { eventLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];
const other = (t: Team): Team => (t === 'RED' ? 'BLACK' : 'RED');

const QUESTION_MAX = 300; // лимит вопроса опроса Telegram

function questionFor(ev: CalendarEvent): string {
  const when = eventLabel(ev.start, ev.startDateTime);
  const loc = ev.location ? ` [${ev.location}]` : '';
  return `${ev.summary} ${when}${loc}`.slice(0, QUESTION_MAX);
}

/**
 * Отправить один опрос в чат команды: сохранить poll_session (для сбора голосов),
 * при forward — продублировать (forward) в чат другой команды. Общий код для
 * авторассылки (sendWeeklyPolls) и публикации черновика (publishPollDraft).
 */
async function sendPollForEvent(
  api: Api,
  p: {
    team: Team;
    question: string;
    options: string[];
    eventUid: string | null;
    eventStart: string | null;
    forward: boolean;
  },
): Promise<{ messageId: number; pollId: string | null; forwarded: boolean }> {
  const chat = env.chats[p.team];
  const msg = await api.sendPoll(
    chat.chatId,
    p.question,
    p.options.map((text) => ({ text })),
    {
      is_anonymous: false,
      disable_notification: true,
      ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
    },
  );

  if (msg.poll) {
    await savePollSession({
      poll_id: msg.poll.id,
      event_uid: p.eventUid,
      team: p.team,
      chat_id: chat.chatId,
      message_id: msg.message_id,
      thread_id: chat.threadId ?? null,
      question: p.question,
      options: p.options,
      event_start: p.eventStart,
    });
  }

  let forwarded = false;
  if (p.forward) {
    const dst = env.chats[other(p.team)];
    await api.forwardMessage(dst.chatId, chat.chatId, msg.message_id, {
      disable_notification: true,
      ...(dst.threadId ? { message_thread_id: dst.threadId } : {}),
    });
    forwarded = true;
  }

  return { messageId: msg.message_id, pollId: msg.poll?.id ?? null, forwarded };
}

/** События обеих команд на ближайшие POLL_HORIZON_DAYS дней. */
async function eventsForWeek(): Promise<{ team: Team; events: CalendarEvent[] }[]> {
  const now = new Date();
  const timeMax = new Date(now.getTime() + env.POLL_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const out: { team: Team; events: CalendarEvent[] }[] = [];
  for (const team of TEAMS) {
    try {
      out.push({ team, events: await listEvents(team, now, timeMax) });
    } catch (err) {
      log.error(`[polls] не удалось прочитать календарь ${team}`, (err as Error).message);
    }
  }
  return out;
}

/**
 * Разослать опросы по событиям на ближайшие POLL_HORIZON_DAYS дней (авторассылка по cron).
 * Тренировки (TYPE=TRAINING) дублируются (forward) в чат другой команды —
 * игроки могут посещать оба зала.
 */
export async function sendWeeklyPolls(api: Api): Promise<{ sent: number; forwarded: number }> {
  let sent = 0;
  let forwarded = 0;

  for (const { team, events } of await eventsForWeek()) {
    for (const ev of events) {
      try {
        const res = await sendPollForEvent(api, {
          team,
          question: questionFor(ev),
          options: env.POLL_OPTIONS,
          eventUid: ev.uid,
          eventStart: ev.start,
          forward: ev.tags.TYPE === 'TRAINING',
        });
        sent++;
        if (res.forwarded) forwarded++;
      } catch (err) {
        log.error(`[polls] ошибка отправки опроса (${team}: ${ev.summary})`, (err as Error).message);
      }
    }
  }

  log.info(`[polls] отправлено ${sent}, переслано ${forwarded}`);
  return { sent, forwarded };
}

/**
 * Собрать черновики опросов на ближайшую неделю (для ручной проверки в личке).
 * На каждое событие — строка poll_drafts со status=pending. Возвращает созданные
 * черновики (по порядку событий каждой команды).
 */
export async function buildPollDrafts(): Promise<PollDraftRow[]> {
  const drafts: PollDraftRow[] = [];
  for (const { team, events } of await eventsForWeek()) {
    for (const ev of events) {
      const isTraining = ev.tags.TYPE === 'TRAINING';
      const id = await createPollDraft({
        team,
        event_uid: ev.uid,
        question: questionFor(ev),
        options: env.POLL_OPTIONS,
        event_start: ev.start,
        is_training: isTraining,
        forward: isTraining,
      });
      const draft = await getPollDraft(id);
      if (draft) drafts.push(draft);
    }
  }
  log.info(`[polls] подготовлено черновиков: ${drafts.length}`);
  return drafts;
}

/**
 * Опубликовать черновик в чат команды с текущими (возможно отредактированными)
 * текстом/вариантами/форвардом. Бросает ошибку, если черновик уже отправлен/пропущен.
 */
export async function publishPollDraft(
  api: Api,
  draftId: number,
): Promise<{ team: Team; forwarded: boolean }> {
  const draft = await getPollDraft(draftId);
  if (!draft) throw new Error(`Черновик #${draftId} не найден`);
  if (draft.status !== 'pending') {
    throw new Error(draft.status === 'sent' ? 'Этот опрос уже отправлен' : 'Этот опрос пропущен');
  }

  const res = await sendPollForEvent(api, {
    team: draft.team,
    question: draft.question,
    options: draft.options,
    eventUid: draft.event_uid,
    eventStart: draft.event_start,
    forward: draft.forward,
  });

  await setPollDraftSent(draftId, res.pollId);
  return { team: draft.team, forwarded: res.forwarded };
}
