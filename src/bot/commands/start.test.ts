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
    const player = (await db.query<{ tg_user_id: string }>(
      "select tg_user_id from players where lower(tg_login)='@testplayer'",
    )).rows[0]!;
    assert.equal(Number(player.tg_user_id), 12345);
    assert.equal((await checkTeamChatMembership(api as never, 'RED', ['@TestPlayer']))[0]?.status, 'member');
    assert.equal(checkedUserId, 12345);
  } finally {
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
