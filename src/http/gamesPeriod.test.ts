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
    await db.exec(`insert into games(team,opponent,played_on,month,year,participants) values
      ('BLACK','Матч ноября','2026-11-01',12,2026,'[]'),('RED','Матч октября','2026-10-31',11,2026,'[]'),('BLACK','Матч декабря','2026-12-31',1,2027,'[]'),('BLACK','Матч января','2027-01-01',2,2027,'[]')`);
    await db.exec(`insert into scheduled_games(source,source_url,external_id,team,team_a,team_b,game_date) values
      ('MLBL','https://example.com','oct','BLACK','Yandex Black','Расписание октября','2026-10-31'),
      ('MLBL','https://example.com','nov','BLACK','Yandex Black','Расписание ноября','2026-11-01')`);
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
    assert.deepEqual(period(page.body), ['10', '2026']);
    assert.match(page.body, /Матч октября/);
    assert.doesNotMatch(page.body, /Матч ноября|Матч января|NaN/);
    const november = await get('/games?month=11&year=2026');
    assert.deepEqual(period(november.body), ['11', '2026']);
    assert.match(november.body, /Матч ноября/);
    assert.doesNotMatch(november.body, /Матч октября/);
    assert.match(november.body, /Расписание ноября/);
    assert.doesNotMatch(november.body, /Расписание октября/);
    assert.match(page.body, /Расписание октября/);
    assert.doesNotMatch(page.body, /Расписание ноября/);
    const forms = parse(page.body);
    assert.equal(forms.querySelector('form[action="/games/add"] input[name="month"]')!.getAttribute('value'),'11');
    assert.equal(forms.querySelector('form[action="/games/add"] input[name="view_month"]')!.getAttribute('value'),'10');
    assert.equal(forms.querySelector('form[action="/games/check-stats"] input[name="month"]')!.getAttribute('value'),'11');
    assert.equal(forms.querySelector('form[action="/games/import"] input[name="month"]')!.getAttribute('value'),'11');
    const selected = await get('/games?month=10&year=2026');
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(period(selected.body), ['10', '2026']);
    assert.match(selected.body, /Матч октября/);
    assert.doesNotMatch(selected.body, /Матч ноября/);
    assert.deepEqual(period((await get('/games?month=10')).body), ['10', '2026']);
    assert.deepEqual(period((await get('/games?year=2027')).body), ['10', '2027']);
    for (const query of ['month=NaN', 'year=nope', 'month=0', 'month=13', 'month=1.5', 'year=2026.5', 'year=2023', 'year=2101', 'month=', 'year=']) {
      queries = 0;
      const invalid = await get('/games?' + query);
      assert.equal(invalid.statusCode, 302, query);
      assert.equal(queries, 0, query);
      const target = new URL(invalid.headers.location!, 'http://localhost');
      assert.equal(target.searchParams.get('month'), '10');
      assert.equal(target.searchParams.get('year'), '2026');
      assert.match(target.searchParams.get('msg')!, /Неверный месяц или год/);
    }
    mock.timers.setTime(new Date('2026-12-15T12:00:00+03:00').getTime());
    const december = await get('/games');
    assert.deepEqual(period(december.body), ['12', '2026']);
    assert.match(december.body, /Матч декабря/);
    const january = await get('/games?month=1&year=2027');
    assert.equal(january.statusCode, 200);
    assert.deepEqual(period(january.body), ['1', '2027']);
    assert.match(january.body, /Матч января/);
    assert.doesNotMatch(january.body, /Матч ноября|NaN/);
    const decemberForms = parse(december.body);
    assert.equal(decemberForms.querySelector('form[action="/games/add"] input[name="month"]')!.getAttribute('value'),'1');
    assert.equal(decemberForms.querySelector('form[action="/games/add"] input[name="year"]')!.getAttribute('value'),'2027');

    // Изменения записываются в месяц бюджета, возврат — в месяц проведения игры.
    await db.exec("insert into players(name,tg_login,team,is_employee) values ('Игрок','@player','BLACK',true)");
    const post = (url: string, payload: Record<string,string>) => app!.inject({ method: 'POST', url, cookies, payload });
    const view = { view_month: '10', view_year: '2026' };
    const assertBack = (location: string) => {
      const url = new URL(location, 'http://localhost');
      assert.equal(url.searchParams.get('month'), '10');
      assert.equal(url.searchParams.get('year'), '2026');
    };
    const added = await post('/games/add', { ...view, month:'11',year:'2026',team:'BLACK',date:'2026-10-20',opponent:'Ручная игра',logins:'@player',coach:'yes' });
    assertBack(added.headers.location!);
    const manual = (await db.query<{id:number;month:number;year:number}>("select * from games where opponent='Ручная игра'")).rows[0]!;
    assert.equal(manual.month, 11);
    assert.equal(manual.year, 2026);
    assert.match((await get('/games?month=10&year=2026')).body, /Ручная игра/);
    assertBack((await post(`/games/${manual.id}/flags`, { ...view,coach_present:'no',judge:'no' })).headers.location!);
    assert.equal((await db.query<{coach_present:boolean}>('select coach_present from games where id=$1',[manual.id])).rows[0]!.coach_present,false);
    assertBack((await post(`/games/${manual.id}/delete`, view)).headers.location!);
    assert.equal((await db.query('select * from games where id=$1',[manual.id])).rows.length,0);
  } finally {
    mock.timers.reset();
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
