import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listEvents, type CalendarEvent } from '../google/calendar.js';
import { pollSessionExistsForEvent, savePollSession } from '../db/repos/polls.repo.js';
import {
  createPollDraft,
  getPollDraft,
  setPollDraftSent,
  type PollDraftRow,
} from '../db/repos/pollDrafts.repo.js';
import { eventLabel } from '../domain/dates.js';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';
import { markScheduledGamePollSentForEvent } from '../db/repos/scheduledGames.repo.js';

const TEAMS: Team[] = ['RED', 'BLACK'];
const other = (t: Team): Team => (t === 'RED' ? 'BLACK' : 'RED');

/** Вид рассылки: тренировки или игры — у каждого своё расписание и горизонт. */
export type PollKind = 'training' | 'game';

/** Подходит ли событие под вид рассылки по тегу TYPE. */
function matchesKind(ev: CalendarEvent, kind: PollKind): boolean {
  return kind === 'training'
    ? ev.tags.TYPE === 'TRAINING'
    : ev.tags.TYPE === 'GAME' || ev.tags.TYPE === 'FRIENDLY';
}

/** Горизонт (дней) для вида рассылки: cron_config → фолбэк на env. */
async function horizonFor(kind: PollKind): Promise<number> {
  const fallback = kind === 'training' ? env.POLL_TRAINING_HORIZON_DAYS : env.POLL_GAME_HORIZON_DAYS;
  try {
    const cfg = await getCronConfig();
    const days = kind === 'training' ? cfg.poll_training_horizon_days : cfg.poll_game_horizon_days;
    return days && days > 0 ? days : fallback;
  } catch {
    return fallback;
  }
}

const QUESTION_MAX = 300; // лимит вопроса опроса Telegram

type PollCalendarEvent = Pick<CalendarEvent, 'uid' | 'team' | 'summary' | 'location' | 'start' | 'startDateTime'>;

function questionFor(ev: PollCalendarEvent): string {
  const when = eventLabel(ev.start, ev.startDateTime);
  const loc = ev.location ? ` [${ev.location}]` : '';
  return `${ev.summary} ${when}${loc}`.slice(0, QUESTION_MAX);
}

/**
 * Отправить один опрос в чат команды: сохранить poll_session (для сбора голосов),
 * при forward — продублировать (forward) в чат другой команды. Общий код для
 * авторассылки (sendWeeklyPolls) и публикации черновика (publishPollDraft).
 */
interface PollSendInput {
  team: Team;
  question: string;
  options: string[];
  eventUid: string | null;
  eventStart: string | null;
  forward: boolean;
}

interface PollSendResult {
  sent: boolean;
  messageId: number | null;
  pollId: string | null;
  forwarded: boolean;
}

const runningPollSends = new Map<string, Promise<PollSendResult>>();

async function performPollSend(api: Api, p: PollSendInput): Promise<PollSendResult> {
  if (p.eventUid && await pollSessionExistsForEvent(p.team, p.eventUid)) {
    return { sent: false, messageId: null, pollId: null, forwarded: false };
  }
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

  if (!msg.poll) throw new Error('Telegram не вернул poll.id для отправленной голосовалки');
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
  if (p.eventUid) await markScheduledGamePollSentForEvent(p.team, p.eventUid);

  let forwarded = false;
  if (p.forward) {
    const dst = env.chats[other(p.team)];
    await api.forwardMessage(dst.chatId, chat.chatId, msg.message_id, {
      disable_notification: true,
      ...(dst.threadId ? { message_thread_id: dst.threadId } : {}),
    });
    forwarded = true;
  }

  return { sent: true, messageId: msg.message_id, pollId: msg.poll.id, forwarded };
}

async function sendPollForEvent(api: Api, p: PollSendInput): Promise<PollSendResult> {
  if (!p.eventUid) return performPollSend(api, p);
  const key = `${p.team}:${p.eventUid}`;
  const running = runningPollSends.get(key);
  if (running) {
    const result = await running;
    return { ...result, sent: false, forwarded: false };
  }
  const task = performPollSend(api, p);
  runningPollSends.set(key, task);
  try {
    return await task;
  } finally {
    if (runningPollSends.get(key) === task) runningPollSends.delete(key);
  }
}

/** Отправить голосовалку для конкретной игры, если её ещё не было. */
export async function sendGamePollForEvent(api: Api, ev: PollCalendarEvent): Promise<{ sent: boolean }> {
  const result = await sendPollForEvent(api, {
    team: ev.team,
    question: questionFor(ev),
    options: env.POLL_OPTIONS,
    eventUid: ev.uid,
    eventStart: ev.start,
    forward: false,
  });
  return { sent: result.sent };
}

/** События обеих команд на ближайшие horizonDays дней. */
async function eventsInWindow(horizonDays: number): Promise<{ team: Team; events: CalendarEvent[] }[]> {
  const now = new Date();
  const timeMax = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
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
 * Разослать опросы одного вида (авторассылка по cron).
 * kind='training' — события TYPE=TRAINING, дублируются (forward) в чат другой команды
 * (игроки посещают оба зала); горизонт — poll_training_horizon_days.
 * kind='game' — события TYPE=GAME|FRIENDLY, без форварда; горизонт — poll_game_horizon_days.
 */
export async function sendWeeklyPolls(
  api: Api,
  kind: PollKind,
): Promise<{ sent: number; forwarded: number }> {
  let sent = 0;
  let forwarded = 0;
  const forward = kind === 'training';
  const horizon = await horizonFor(kind);

  for (const { team, events } of await eventsInWindow(horizon)) {
    for (const ev of events) {
      if (!matchesKind(ev, kind)) continue;
      try {
        const res = await sendPollForEvent(api, {
          team,
          question: questionFor(ev),
          options: env.POLL_OPTIONS,
          eventUid: ev.uid,
          eventStart: ev.start,
          forward,
        });
        if (res.sent) sent++;
        if (res.forwarded) forwarded++;
      } catch (err) {
        log.error(`[polls] ошибка отправки опроса (${team}: ${ev.summary})`, (err as Error).message);
      }
    }
  }

  log.info(`[polls:${kind}] отправлено ${sent}, переслано ${forwarded}`);
  return { sent, forwarded };
}

/**
 * Собрать черновики опросов на ближайшую неделю (для ручной проверки в личке).
 * На каждое событие — строка poll_drafts со status=pending. Возвращает созданные
 * черновики (по порядку событий каждой команды).
 */
export async function buildPollDrafts(): Promise<PollDraftRow[]> {
  const drafts: PollDraftRow[] = [];
  // По каждому виду — свой горизонт и фильтр по TYPE; форвард только для тренировок.
  // Виды не пересекаются (TRAINING vs GAME/FRIENDLY), поэтому события не дублируются.
  for (const kind of ['training', 'game'] as const) {
    const forward = kind === 'training';
    for (const { team, events } of await eventsInWindow(await horizonFor(kind))) {
      for (const ev of events) {
        if (!matchesKind(ev, kind)) continue;
        const id = await createPollDraft({
          team,
          event_uid: ev.uid,
          question: questionFor(ev),
          options: env.POLL_OPTIONS,
          event_start: ev.start,
          is_training: forward,
          forward,
        });
        const draft = await getPollDraft(id);
        if (draft) drafts.push(draft);
      }
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
