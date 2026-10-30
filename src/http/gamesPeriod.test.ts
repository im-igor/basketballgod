import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parse } from 'node-html-parser';
import type { Bot } from 'grammy';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { buildServer } from './server.js';

test('Игры открываются из меню без периода, сохраняют выбранный месяц и отвергают неверные параметры до запроса в БД', async () => {
  const db = new PGlite();
  let queries = 0;
  const sql = async (text: string, params?: unknown[]) => {
    queries++;
    assert.ok(!params?.some(p => typeof p === 'number' && !Number.isFinite(p)));
    return params ? db.query(text, params) : (await db.exec(text)).at(-1)!;
  };
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release() {} }));
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await migrate();
    await db.exec(`insert into games(team,opponent,month,year,participants) values
      ('BLACK','Матч ноября',11,2026,'[]'),('RED','Матч октября',10,2026,'[]'),('BLACK','Матч января',1,2027,'[]')`);
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T12:00:00+03:00') });
    app = await buildServer({ api: {} } as Bot);
    const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'test', password: 'test-password' } });
    const cookies = { bbg_auth: login.cookies[0]!.value };
    const get = (url: string) => app!.inject({ method: 'GET', url, cookies });
    const period = (html: string) => {
      const form = parse(html).querySelector('form[action="/games"]')!;
      return ['month', 'year'].map(name => form.querySelector(`input[name="${name}"]`)!.getAttribute('value'));
    };
    const page = await get('/games');
    assert.equal(page.statusCode, 200);
    assert.deepEqual(period(page.body), ['11', '2026']);
    assert.match(page.body, /Матч ноября/);
    assert.doesNotMatch(page.body, /Матч октября|Матч января|NaN/);
    const selected = await get('/games?month=10&year=2026');
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(period(selected.body), ['10', '2026']);
    assert.match(selected.body, /Матч октября/);
    assert.doesNotMatch(selected.body, /Матч ноября/);
    assert.deepEqual(period((await get('/games?month=10')).body), ['10', '2026']);
    assert.deepEqual(period((await get('/games?year=2027')).body), ['11', '2027']);
    for (const query of ['month=NaN', 'year=nope', 'month=0', 'month=13', 'month=1.5', 'year=2026.5', 'year=2023', 'year=2101', 'month=', 'year=']) {
      queries = 0;
      const invalid = await get('/games?' + query);
      assert.equal(invalid.statusCode, 302, query);
      assert.equal(queries, 0, query);
      const target = new URL(invalid.headers.location!, 'http://localhost');
      assert.equal(target.searchParams.get('month'), '11');
      assert.equal(target.searchParams.get('year'), '2026');
      assert.match(target.searchParams.get('msg')!, /Неверный месяц или год/);
    }
    mock.timers.setTime(new Date('2026-12-15T12:00:00+03:00').getTime());
    const january = await get('/games');
    assert.equal(january.statusCode, 200);
    assert.deepEqual(period(january.body), ['1', '2027']);
    assert.match(january.body, /Матч января/);
    assert.doesNotMatch(january.body, /Матч ноября|NaN/);
  } finally {
    mock.timers.reset();
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
