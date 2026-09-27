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
  listScheduledGames,
  setScheduledGameCalendarEventId,
  upsertScheduledGame,
} from '../db/repos/scheduledGames.repo.js';
import { buildServer } from '../http/server.js';
import { startScheduler } from '../scheduler/cron.js';
import { refreshScheduleSource } from './scheduleRefresh.service.js';
import { sendPendingScheduledGamePolls } from './schedulePoll.service.js';

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
  await db.exec('truncate poll_votes, poll_sessions, schedule_sources, scheduled_games restart identity cascade');
  await db.exec(`update cron_config set
    schedule_import_enabled = false,
    schedule_import_interval_minutes = 60,
    schedule_import_send_polls = false`);
});

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

test('новая игра получает одну голосовалку, повторная проверка её не дублирует', async () => {
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
  assert.deepEqual(first, { sent: 1, alreadySent: 0, errors: [] });
  assert.deepEqual(second, { sent: 0, alreadySent: 0, errors: [] });
  assert.equal(telegramCalls, 1);
  const saved = await getScheduledGameById(game.id);
  assert.equal(saved!.poll_pending, false);
  assert.ok(saved!.poll_sent_at);
  assert.equal(saved!.poll_last_error, null);
});

test('голосовалка регулярного cron блокирует повторную рассылку после импорта', async () => {
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
  assert.deepEqual(result, { sent: 0, alreadySent: 1, errors: [] });
  assert.equal((await getScheduledGameById(game.id))!.poll_pending, false);
});

test('ошибка Telegram оставляет голосовалку в очереди для следующей попытки', async () => {
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
