import '../../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Bot, Context } from 'grammy';

test('/start привязывает Telegram ID к игроку для проверки чата', async () => {
  const [{ pool }, { migrate }, { registerCommands }, { checkTeamChatMembership }] = await Promise.all([
    import('../../db/pool.js'), import('../../db/migrator.js'), import('./index.js'),
    import('../../services/chatCheck.service.js'),
  ]);
  const db = new PGlite();
  const sql = (text: string, params?: unknown[]) => params
    ? db.query(text, params)
    : db.exec(text).then((results) => results.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release: () => undefined }));
  try {
    await migrate();
    await db.query("insert into players (name, tg_login, team) values ('Тестовый Игрок', '@TestPlayer', 'RED')");
    const handlers = new Map<string, (ctx: Context) => Promise<void>>();
    const bot = { command: (name: string, handler: (ctx: Context) => Promise<void>) => {
      handlers.set(name, handler);
    } } as unknown as Bot;
    registerCommands(bot);
    assert.equal(handlers.has('budget'), false);
    let checkedUserId: unknown;
    const api = { getChatMember: async (_chatId: number, userId: number) => {
      checkedUserId = userId;
      return { status: 'member' };
    } };
    assert.equal((await checkTeamChatMembership(api as never, 'RED', ['@TestPlayer']))[0]?.status, 'missing_id');
    let reply = '';
    await handlers.get('start')!({
      from: { id: 12345, username: 'testplayer' },
      chat: { type: 'private' },
      reply: async (text: string) => { reply = text; },
    } as unknown as Context);
    assert.match(reply, /Telegram ID привязан/);
    assert.match(reply, /Сборка бюджета, корректировки и публикация доступны в админке/);
    const player = (await db.query<{ tg_user_id: string }>(
      "select tg_user_id from players where lower(tg_login)='@testplayer'",
    )).rows[0]!;
    assert.equal(Number(player.tg_user_id), 12345);
    assert.equal((await checkTeamChatMembership(api as never, 'RED', ['@TestPlayer']))[0]?.status, 'member');
    assert.equal(checkedUserId, 12345);

    const logins = ['@TestPlayer'];
    for (let i = 0; i < 8; i++) {
      const login = `@player${i}`;
      logins.push(login);
      await db.query('insert into players (name, tg_login, team, tg_user_id) values ($1,$2,$3,$4)',
        [`Игрок ${i}`, login, 'RED', 100 + i]);
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const checks = await checkTeamChatMembership({ getChatMember: async (_chatId: number, userId: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { status: userId === 100 ? 'left' : 'member' };
    } } as never, 'RED', logins);
    assert.deepEqual(checks.map((check) => check.tg_login), logins);
    assert.equal(checks[1]?.status, 'left');
    assert.ok(maxInFlight > 1 && maxInFlight <= 4);
  } finally {
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
