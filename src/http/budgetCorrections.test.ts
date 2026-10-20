import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { google } from 'googleapis';
import type { Bot } from 'grammy';

test('кнопки корректировки и комментарий меняют оба черновика до подтверждения', async () => {
  const [{ pool }, { migrate }, { buildServer }, { renderBudgetFromDb }] = await Promise.all([
    import('../db/pool.js'), import('../db/migrator.js'), import('./server.js'),
    import('../services/notify.service.js'),
  ]);
  const db = new PGlite();
  const sql = (query: string, params?: unknown[]) => params
    ? db.query(query, params) : db.exec(query).then((results) => results.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release: () => undefined }));
  mock.method(google, 'calendar', () => ({ events: { list: async () => ({ data: { items: [] } }) } }));
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await migrate();
    const correction = {
      source_month: 10, source_year: 2026,
      coach_delta: { RED: -1, BLACK: 0 }, gym_delta: -1,
      coach_rate: 5000, gym_rate: 25500,
      note: 'Отмена тренировки в октябре', note_edited: false, reviewed: false,
      source_changes: ['2026-10-22 RED: отменено или изменено'],
      source_snapshot: [{ uid: 'black-1', team: 'BLACK', start: '2026-10-23T19:00:00+03:00', paid_coach: true, paid_gym: false }],
    };
    const budgetIds: number[] = [];
    for (const team of ['RED', 'BLACK']) {
      const player = (await db.query<{ id: number }>(
        'insert into players (name, tg_login, team) values ($1,$2,$3) returning id',
        [`Игрок ${team}`, `@${team.toLowerCase()}player`, team],
      )).rows[0]!.id;
      const details = {
        total_players: 2, players_team: 1, players_other: 1,
        paid_gym_sessions: 4, coach_sessions: 4,
        gym_per_person: 39750, coach_per_person: 17500, base_per_person: 57250,
        coach_shared_sessions: { RED: 4, BLACK: 4 }, correction,
      };
      const budget = (await db.query<{ id: number }>(
        'insert into budgets (team, month, year, total_per_player, details) values ($1,11,2026,57250,$2) returning id',
        [team, JSON.stringify(details)],
      )).rows[0]!.id;
      budgetIds.push(budget);
      await db.query(
        'insert into charges (budget_id, player_id, tg_login, name, base_amount, amount) values ($1,$2,$3,$4,57250,57250)',
        [budget, player, `@${team.toLowerCase()}player`, `Игрок ${team}`],
      );
    }
    app = await buildServer({ api: {} } as unknown as Bot);
    const login = await app.inject({ method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=test&password=test-password' });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const post = (url: string, values: Record<string, string> = {}) => app!.inject({
      method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(values).toString(),
    });

    const page = await app.inject({ method: 'GET', url: '/budgets/11-2026', headers: { cookie } });
    assert.match(page.body, /Корректировки/);
    assert.match(page.body, /2026-10-22 RED: отменено или изменено/);
    assert.match(page.body, /Актуальный календарь за Октябрь 2026/);
    assert.match(page.body, /23\.10\.2026, 19:00/);
    assert.match(page.body, /Тренер RED/);
    assert.match(page.body, /Зал/);
    assert.match(page.body, /Подтвердить корректировки/);
    const payoutPreview = await app.inject({
      method: 'GET', url: '/budgets/11-2026?preview=payout', headers: { cookie },
    });
    assert.match(payoutPreview.body, /Предварительно по текущему календарю/);
    assert.match(payoutPreview.body, /Начислено за зал — 3000₽/);
    await post('/budgets/11-2026/correction-note', { note: 'Зачёт <октября>' });
    for (const id of budgetIds) {
      assert.match((await renderBudgetFromDb(id))!.text, /Зачёт &lt;октября&gt;/);
    }
    await post('/budgets/11-2026/correction', { component: 'gym', change: '1' });
    for (const id of budgetIds) {
      const budget = (await db.query<{ total_per_player: number; details: { correction: typeof correction } }>(
        'select total_per_player, details from budgets where id=$1', [id],
      )).rows[0]!;
      assert.equal(Number(budget.total_per_player), 70000);
      assert.equal(budget.details.correction.gym_delta, 0);
      assert.equal(budget.details.correction.note, 'Зачёт <октября>');
      assert.equal(budget.details.correction.reviewed, false);
    }
    await post('/budgets/11-2026/correction-review');
    for (const id of budgetIds) {
      const details = (await db.query<{ details: { correction: typeof correction } }>(
        'select details from budgets where id=$1', [id],
      )).rows[0]!.details;
      assert.equal(details.correction.reviewed, true);
    }
    const preview = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.match(preview.body, /Зачёт &lt;октября&gt;/);
  } finally {
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
