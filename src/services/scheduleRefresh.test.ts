import '../test/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Api, Bot } from 'grammy';
import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
import { savePollSession } from '../db/repos/polls.repo.js';
import {
  getScheduleSource,
  listScheduleSources,
  upsertScheduleSource,
} from '../db/repos/scheduleSources.repo.js';
import {
  getScheduledGameById,
  listScheduleDuplicateGroups,
  listScheduledGames,
  markScheduleSourcePresence,
  recomputeScheduleConflicts,
  setScheduledGameCalendarEventId,
  upsertScheduledGame,
} from '../db/repos/scheduledGames.repo.js';
import { buildServer } from '../http/server.js';
import { startScheduler } from '../scheduler/cron.js';
import { refreshScheduleSource } from './scheduleRefresh.service.js';
import { sendPendingScheduledGamePolls } from './schedulePoll.service.js';
import {
  deleteScheduledGameWithArtifacts,
  notifyScheduleDuplicatesToAdmins,
} from './scheduleDuplicate.service.js';
import {
  beginCronJobWindow,
  completeCronJobWindow,
} from '../db/repos/cronJobWindows.repo.js';

const db = new PGlite();
let queue = Promise.resolve();

async function acquire() {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return release;
}

async function sql(text: string, params?: unknown[]) {
  const result = params ? await db.query(text, params) : (await db.exec(text)).at(-1)!;
  return { ...result, rowCount: result.affectedRows || result.rows.length };
}

before(async () => {
  mock.method(pool, 'query', async (text: string, params?: unknown[]) => {
    const release = await acquire();
    try { return await sql(text, params); } finally { release(); }
  });
  mock.method(pool, 'connect', async () => {
    const release = await acquire();
    return { query: sql, release };
  });
  await migrate();
  await migrate();
});

beforeEach(async () => {
  await db.exec('truncate poll_votes, poll_sessions, schedule_sources, scheduled_games, cron_job_windows restart identity cascade');
  await db.exec(`update cron_config set
    schedule_import_enabled = false,
    schedule_import_interval_minutes = 60,
    schedule_import_send_polls = false`);
});

async function openGamePollWindow(until = new Date('2100-01-01T00:00:00+03:00')): Promise<void> {
  const startedAt = new Date(Date.now() - 1000);
  await beginCronJobWindow('game-polls', startedAt, until);
  await completeCronJobWindow('game-polls', startedAt);
}

after(async () => {
  mock.restoreAll();
  await db.close();
  await pool.end();
});

test('проверка источника сохраняет результат и не запускается параллельно для одного турнира', async () => {
  await upsertScheduleSource({
    source: 'MLBL', team: 'BLACK', url: 'https://moscow.ilovebasket.ru/schedule', enabled: true,
  });
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const importer = async () => {
    calls++;
    await gate;
    return { found: 5, newGames: 2, saved: 5, calendarSynced: 5, errors: [] };
  };
  const first = refreshScheduleSource('MLBL', importer);
  const second = refreshScheduleSource('MLBL', importer);
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  const source = await getScheduleSource('MLBL');
  assert.equal(source!.last_found, 5);
  assert.equal(source!.last_new, 2);
  assert.equal(source!.last_calendar_synced, 5);
  assert.equal(source!.last_error, null);
  assert.ok(source!.last_checked_at);
  assert.ok(source!.last_success_at);
});

test('ошибка проверки видна в статусе, а успешная дата не теряется', async () => {
  await upsertScheduleSource({
    source: 'LCHB', team: 'RED', url: 'https://basketball.businesschampions.ru/vesna-2026/komandy/142588/', enabled: true,
  });
  await refreshScheduleSource('LCHB', async () => ({
    found: 1, newGames: 1, saved: 1, calendarSynced: 1, errors: [],
  }));
  const successfulAt = (await getScheduleSource('LCHB'))!.last_success_at;
  const failed = await refreshScheduleSource('LCHB', async () => { throw new Error('HTTP 503'); });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ['HTTP 503']);
  const source = await getScheduleSource('LCHB');
  assert.equal(source!.last_error, 'HTTP 503');
  assert.equal(source!.last_found, 0);
  assert.equal(source!.last_new, 0);
  assert.deepEqual(source!.last_success_at, successfulAt);
});

test('повторное сохранение матча обновляет запись без дубля', async () => {
  const game = {
    source: 'MLBL' as const,
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    external_id: '1090210',
    team: 'BLACK' as const,
    team_a: 'Yandex Black',
    team_b: 'Соперник',
    game_date: '2026-10-04',
    game_time: '15:00',
    location: 'Зал 1',
    details_url: null,
  };
  const first = await upsertScheduledGame(game);
  const second = await upsertScheduledGame({ ...game, game_time: '16:30', location: 'Зал 2' });
  assert.equal(second.id, first.id);
  assert.equal(second.game_time, '16:30:00');
  assert.equal(second.location, 'Зал 2');
  assert.equal((await listScheduledGames()).length, 1);
});

test('разные внешние ID одного матча образуют дубль, а исчезнувший ID помечается устаревшим', async () => {
  const common = {
    source: 'LCHB' as const,
    source_url: 'https://basketball.businesschampions.ru/vesna-2026/komandy/142588/',
    team: 'RED' as const,
    team_a: 'Yandex Red',
    team_b: 'Транснефть',
    game_date: '2026-10-04',
    game_time: '21:10',
    location: 'Территория мяча',
    details_url: null,
  };
  const oldGame = await upsertScheduledGame({ ...common, external_id: 'old-id' });
  const currentGame = await upsertScheduledGame({
    ...common,
    external_id: '1477340',
    team_a: ' транснефть ',
    team_b: 'YANDEX  RED',
  });
  await markScheduleSourcePresence('LCHB', 'RED', ['1477340']);

  const groups = await listScheduleDuplicateGroups('LCHB', 'RED');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.games.map((game) => game.id), [oldGame.id, currentGame.id]);
  const games = await listScheduledGames();
  assert.equal(games.find((game) => game.id === oldGame.id)!.present_in_source, false);
  assert.equal(games.find((game) => game.id === currentGame.id)!.present_in_source, true);
});

test('список расписания идёт от поздних игр к ранним, включая будущие', async () => {
  const common = {
    source: 'LCHB' as const,
    source_url: 'https://basketball.businesschampions.ru/vesna-2026/komandy/142588/',
    team: 'RED' as const,
    team_a: 'Yandex Red', team_b: 'Соперник',
    game_time: '19:00', location: null, details_url: null,
  };
  for (const [external_id, game_date] of [
    ['october-18', '2026-10-18'], ['november-01', '2026-11-01'],
    ['october-04', '2026-10-04'], ['october-25', '2026-10-25'],
  ]) await upsertScheduledGame({ ...common, external_id: external_id!, game_date: game_date! });

  assert.deepEqual((await listScheduledGames()).map((game) => game.external_id),
    ['november-01', 'october-25', 'october-18', 'october-04']);
  assert.deepEqual((await listScheduledGames(2)).map((game) => game.external_id),
    ['november-01', 'october-25']);
});

test('бот уведомляет администраторов о дубле только один раз', async () => {
  const common = {
    source: 'MLBL' as const,
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    team: 'BLACK' as const,
    team_a: 'Yandex Black',
    team_b: 'Соперник',
    game_date: '2099-10-04',
    game_time: '15:00',
    location: null,
    details_url: null,
  };
  await upsertScheduledGame({ ...common, external_id: 'old' });
  await upsertScheduledGame({ ...common, external_id: 'new' });
  const sent: string[] = [];
  const api = {
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
      return { message_id: sent.length };
    },
  } as unknown as Api;

  const first = await notifyScheduleDuplicatesToAdmins(api, await listScheduleDuplicateGroups());
  const second = await notifyScheduleDuplicatesToAdmins(api, await listScheduleDuplicateGroups());
  assert.equal(first.groupsNotified, 1);
  assert.equal(first.messagesSent, 1);
  assert.equal(second.groupsNotified, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /возможный дубль/i);
  assert.match(sent[0]!, /ID <code>old<\/code>/);
  assert.match(sent[0]!, /ID <code>new<\/code>/);
});

test('админка показывает дубль без технического статуса источника и кнопку удаления', async () => {
  const common = {
    source: 'LCHB' as const,
    source_url: 'https://basketball.businesschampions.ru/vesna-2099/komandy/142588/',
    team: 'RED' as const,
    team_a: 'Yandex Red',
    team_b: 'Транснефть',
    game_date: '2099-10-04',
    game_time: '21:10',
    location: null,
    details_url: null,
  };
  await upsertScheduledGame({ ...common, external_id: 'old' });
  await upsertScheduledGame({ ...common, external_id: 'new' });
  await markScheduleSourcePresence('LCHB', 'RED', ['new']);
  const app = await buildServer({ api: {} } as Bot);
  try {
    const login = await app.inject({
      method: 'POST', url: '/login', payload: { username: 'test', password: 'test-password' },
    });
    const cookies = { bbg_auth: login.cookies[0]!.value };
    const schedule = await app.inject({ method: 'GET', url: '/schedule', cookies });
    assert.equal(schedule.statusCode, 200);
    assert.match(schedule.body, /возможный дубль/);
    assert.match(schedule.body, /<th>Дубли<\/th>/);
    assert.doesNotMatch(schedule.body, /есть в источнике/);
    assert.doesNotMatch(schedule.body, /нет в источнике/);
    assert.equal((schedule.body.match(/Удалить лишнюю/g) ?? []).length, 2);
    assert.match(schedule.body, /<main class="wide">/);
    assert.match(schedule.body, /class="card table-scroll"/);
  } finally {
    await app.close();
  }
});

test('ручное удаление убирает только выбранный дубль и снимает ложный конфликт тренера', async () => {
  const common = {
    source: 'LCHB' as const,
    source_url: 'https://basketball.businesschampions.ru/vesna-2099/komandy/142588/',
    team: 'RED' as const,
    team_a: 'Yandex Red',
    team_b: 'Транснефть',
    game_date: '2099-10-04',
    game_time: '21:10',
    location: null,
    details_url: null,
  };
  const oldGame = await upsertScheduledGame({ ...common, external_id: 'old' });
  const currentGame = await upsertScheduledGame({ ...common, external_id: 'new' });
  await setScheduledGameCalendarEventId(oldGame.id, 'calendar-old');
  await savePollSession({
    poll_id: 'poll-old',
    event_uid: 'calendar-old',
    team: 'RED',
    chat_id: -2,
    message_id: 404,
    thread_id: null,
    question: 'Игра',
    options: ['Да', 'Нет'],
    event_start: '2099-10-04T18:10:00.000Z',
  });
  await recomputeScheduleConflicts();
  assert.equal((await getScheduledGameById(currentGame.id))!.coach_conflict, true);
  let syncedId: string | null = null;
  let deletedCalendar: string | null = null;

  const result = await deleteScheduledGameWithArtifacts(oldGame.id, {
    deleteCalendar: async (_team, eventId) => { deletedCalendar = eventId; },
    syncGame: async (game) => { syncedId = game.id; },
  });
  assert.equal(result.deleted.id, oldGame.id);
  assert.equal(deletedCalendar, 'calendar-old');
  assert.equal(await getScheduledGameById(oldGame.id), null);
  assert.equal((await getScheduledGameById(currentGame.id))!.coach_conflict, false);
  assert.equal(syncedId, currentGame.id);
  assert.equal((await listScheduledGames()).length, 1);
  const polls = await db.query<{ count: string }>('select count(*)::text as count from poll_sessions where poll_id = $1', ['poll-old']);
  assert.equal(polls.rows[0]!.count, '1', 'Telegram-опрос остаётся для ручного удаления');
});

test('новая игра получает одну голосовалку, повторная проверка её не дублирует', async () => {
  await openGamePollWindow();
  const game = await upsertScheduledGame({
    source: 'MLBL',
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    external_id: 'future-1',
    team: 'BLACK',
    team_a: 'Yandex Black',
    team_b: 'Соперник',
    game_date: '2099-10-04',
    game_time: '15:00',
    location: 'Зал 1',
    details_url: null,
  });
  await setScheduledGameCalendarEventId(game.id, 'calendar-future-1');
  let telegramCalls = 0;
  const api = {
    sendPoll: async () => {
      telegramCalls++;
      return { message_id: 101, poll: { id: 'telegram-poll-1' } };
    },
  } as unknown as Api;

  const first = await sendPendingScheduledGamePolls(api, 'MLBL');
  const second = await sendPendingScheduledGamePolls(api, 'MLBL');
  assert.deepEqual(first, { sent: 1, alreadySent: 0, deferred: 0, errors: [] });
  assert.deepEqual(second, { sent: 0, alreadySent: 0, deferred: 0, errors: [] });
  assert.equal(telegramCalls, 1);
  const saved = await getScheduledGameById(game.id);
  assert.equal(saved!.poll_pending, false);
  assert.ok(saved!.poll_sent_at);
  assert.equal(saved!.poll_last_error, null);
});

test('голосовалка регулярного cron блокирует повторную рассылку после импорта', async () => {
  await openGamePollWindow();
  const game = await upsertScheduledGame({
    source: 'LCHB',
    source_url: 'https://basketball.businesschampions.ru/vesna-2099/komandy/142588/',
    external_id: 'future-2',
    team: 'RED',
    team_a: 'Yandex Red',
    team_b: 'Соперник',
    game_date: '2099-10-05',
    game_time: '17:00',
    location: null,
    details_url: null,
  });
  await setScheduledGameCalendarEventId(game.id, 'calendar-future-2');
  await savePollSession({
    poll_id: 'weekly-poll',
    event_uid: 'calendar-future-2',
    team: 'RED',
    chat_id: -2,
    message_id: 202,
    thread_id: null,
    question: 'Игра',
    options: ['Да', 'Нет'],
    event_start: '2099-10-05T14:00:00.000Z',
  });
  const api = { sendPoll: async () => { throw new Error('не должен вызываться'); } } as unknown as Api;
  const result = await sendPendingScheduledGamePolls(api, 'LCHB');
  assert.deepEqual(result, { sent: 0, alreadySent: 1, deferred: 0, errors: [] });
  assert.equal((await getScheduledGameById(game.id))!.poll_pending, false);
});

test('ошибка Telegram оставляет голосовалку в очереди для следующей попытки', async () => {
  await openGamePollWindow();
  const game = await upsertScheduledGame({
    source: 'MLBL',
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    external_id: 'future-3',
    team: 'BLACK',
    team_a: 'Yandex Black',
    team_b: 'Ещё соперник',
    game_date: '2099-10-06',
    game_time: '19:00',
    location: null,
    details_url: null,
  });
  await setScheduledGameCalendarEventId(game.id, 'calendar-future-3');
  const failed = await sendPendingScheduledGamePolls({
    sendPoll: async () => { throw new Error('Telegram 503'); },
  } as unknown as Api, 'MLBL');
  assert.equal(failed.sent, 0);
  assert.match(failed.errors[0]!, /Telegram 503/);
  const pending = await getScheduledGameById(game.id);
  assert.equal(pending!.poll_pending, true);
  assert.equal(pending!.poll_last_error, 'Telegram 503');

  const retried = await sendPendingScheduledGamePolls({
    sendPoll: async () => ({ message_id: 303, poll: { id: 'retry-poll' } }),
  } as unknown as Api, 'MLBL');
  assert.equal(retried.sent, 1);
  assert.equal((await getScheduledGameById(game.id))!.poll_pending, false);
});

test('новая игра вне сохранённого горизонта ждёт следующего планового cron', async () => {
  await openGamePollWindow(new Date('2099-10-05T00:00:00+03:00'));
  const game = await upsertScheduledGame({
    source: 'MLBL',
    source_url: 'https://moscow.ilovebasket.ru/schedule',
    external_id: 'outside-window',
    team: 'BLACK',
    team_a: 'Yandex Black',
    team_b: 'Дальний соперник',
    game_date: '2099-10-06',
    game_time: '19:00',
    location: null,
    details_url: null,
  });
  await setScheduledGameCalendarEventId(game.id, 'calendar-outside-window');
  const result = await sendPendingScheduledGamePolls({
    sendPoll: async () => { throw new Error('не должен вызываться'); },
  } as unknown as Api, 'MLBL');

  assert.deepEqual(result, { sent: 0, alreadySent: 0, deferred: 1, errors: [] });
  assert.equal((await getScheduledGameById(game.id))!.poll_pending, true);
});

test('игра, известная до планового cron, не получает внеочередную голосовалку', async () => {
  const game = await upsertScheduledGame({
    source: 'LCHB',
    source_url: 'https://basketball.businesschampions.ru/vesna-2099/komandy/142588/',
    external_id: 'known-before-cron',
    team: 'RED',
    team_a: 'Yandex Red',
    team_b: 'Старый соперник',
    game_date: '2099-10-04',
    game_time: '17:00',
    location: null,
    details_url: null,
  });
  await setScheduledGameCalendarEventId(game.id, 'calendar-known-before-cron');
  await db.query('update scheduled_games set created_at = $2 where id = $1', [game.id, new Date('2025-01-01')]);
  await openGamePollWindow();

  const result = await sendPendingScheduledGamePolls({
    sendPoll: async () => { throw new Error('не должен вызываться'); },
  } as unknown as Api, 'LCHB');
  assert.deepEqual(result, { sent: 0, alreadySent: 0, deferred: 1, errors: [] });
  assert.equal((await getScheduledGameById(game.id))!.poll_pending, true);
});

test('админка показывает источники и сохраняет параметры периодического импорта', async () => {
  await upsertScheduleSource({
    source: 'MLBL', team: 'BLACK', url: 'https://moscow.ilovebasket.ru/schedule', enabled: true,
  });
  assert.equal((await listScheduleSources(true)).length, 1);
  const scheduled: string[] = [];
  const scheduleMock = mock.method(cron, 'schedule', ((expression: string) => {
    scheduled.push(expression);
    return { stop() {} } as ReturnType<typeof cron.schedule>;
  }) as typeof cron.schedule);
  const bot = { api: {} } as Bot;
  await startScheduler(bot.api);
  const app = await buildServer(bot);
  try {
    const login = await app.inject({
      method: 'POST', url: '/login', payload: { username: 'test', password: 'test-password' },
    });
    const cookies = { bbg_auth: login.cookies[0]!.value };
    const schedule = await app.inject({ method: 'GET', url: '/schedule', cookies });
    assert.equal(schedule.statusCode, 200);
    assert.match(schedule.body, /https:\/\/moscow\.ilovebasket\.ru\/schedule/);
    assert.match(schedule.body, /автопроверка выключена/);

    const update = await app.inject({
      method: 'POST',
      url: '/cron',
      cookies,
      payload: {
        poll_game_weekday: '5',
        poll_game_time: '15:50',
        schedule_import_enabled: 'yes',
        schedule_import_interval_minutes: '120',
        schedule_import_send_polls: 'yes',
      },
    });
    assert.equal(update.statusCode, 302);
    const config = await getCronConfig();
    assert.equal(config.schedule_import_enabled, true);
    assert.equal(config.schedule_import_interval_minutes, 120);
    assert.equal(config.schedule_import_send_polls, true);
    assert.equal(config.poll_game_weekday, 5);
    assert.equal(config.poll_game_time, '15:50');
    assert.ok(scheduled.includes('50 15 * * 5'), 'новое время должно примениться сразу после POST /cron');
    const cron = await app.inject({ method: 'GET', url: '/cron', cookies });
    assert.match(cron.body, /value="120" selected/);
    assert.match(cron.body, /name="schedule_import_send_polls"[^>]*checked/);
  } finally {
    await app.close();
    scheduleMock.mock.restore();
  }
});
