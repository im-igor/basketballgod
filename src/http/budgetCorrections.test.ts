import '../test/env.js';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { runInNewContext } from 'node:vm';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import type { Bot } from 'grammy';

test('единая кнопка применяет комментарий, пересчитывает оба черновика и доступна только после изменений', async () => {
  const [{ pool }, { migrate }, { buildServer }, { renderBudgetFromDb }] = await Promise.all([
    import('../db/pool.js'), import('../db/migrator.js'), import('./server.js'),
    import('../services/notify.service.js'),
  ]);
  const db = new PGlite();
  const sql = (query: string, params?: unknown[]) => params
    ? db.query(query, params) : db.exec(query).then((results) => results.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release: () => undefined }));
  mock.method(calendar_v3.Resource$Events.prototype, 'list', async () => ({ data: { items: [] } }));
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

    const page = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.match(page.body, /Корректировки/);
    assert.match(page.body, /budget-preview-grid/);
    assert.match(page.body, /-1 сессия тренера, -1 аренда зала - за отмену 22\.10\.2026/);
    assert.match(page.body, /Тренер: <b>-1<\/b>/);
    assert.doesNotMatch(page.body, /Тренер RED:/);
    assert.doesNotMatch(page.body, />открыть<\/a>/);
    assert.doesNotMatch(page.body, /Тарифы исходного месяца/);
    assert.match(page.body, /Зал/);
    assert.match(page.body, /Подтвердить корректировки/);
    assert.doesNotMatch(page.body, /Сохранить комментарий|action="[^"]+correction-note"/);
    const initialForm = parse(page.body).querySelector('form[action$="correction-review"]')!;
    assert.ok(initialForm.querySelector('textarea[name="note"]'));
    assert.equal(initialForm.querySelector('button')!.hasAttribute('disabled'), false);
    assert.match(page.body, /disabled>Опубликовать готовые сборы/);
    const detail = await app.inject({ method: 'GET', url: '/budgets/11-2026', headers: { cookie } });
    assert.doesNotMatch(detail.body, /<h2>Корректировки<\/h2>/);
    const payoutPreview = await app.inject({
      method: 'GET', url: '/collections/11-2026/payout', headers: { cookie },
    });
    assert.equal(payoutPreview.statusCode, 200);
    assert.match(payoutPreview.body, /Предварительно по текущему календарю/);
    assert.match(payoutPreview.body, /Начислено за зал — 3000₽/);
    const autoConfirmed = await post('/budgets/11-2026/correction-review', { note: '-1 сессия тренера, -1 аренда зала - за отмену 22.10.2026' });
    assert.match(decodeURIComponent(autoConfirmed.headers.location!), /оба черновика пересчитаны/);
    for (const id of budgetIds) {
      const saved = (await db.query<{details:{correction:typeof correction}}>('select details from budgets where id=$1',[id])).rows[0]!;
      assert.equal(saved.details.correction.reviewed, true);
      assert.equal(saved.details.correction.note_edited, false);
    }
    await post('/budgets/11-2026/correction-review', { note: 'Зачёт <октября>' });
    for (const id of budgetIds) {
      assert.match((await renderBudgetFromDb(id))!.text, /Зачёт &lt;октября&gt;/);
    }
    const changed = await post('/budgets/11-2026/correction', { component: 'gym', change: '1' });
    assert.match(String(changed.headers.location), /^\/budgets\?month=11&year=2026&msg=.*#drafts$/);
    await post('/budgets/11-2026/correction', { component: 'coach', change: '1' });
    const editedPreview = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.match(editedPreview.body, /72500 руб/);
    assert.match(editedPreview.body, /Зачёт &lt;октября&gt;/);
    for (const id of budgetIds) {
      const budget = (await db.query<{ total_per_player: number; details: { correction: typeof correction } }>(
        'select total_per_player, details from budgets where id=$1', [id],
      )).rows[0]!;
      assert.equal(Number(budget.total_per_player), 72500);
      assert.equal(budget.details.correction.gym_delta, 0);
      assert.equal(budget.details.correction.coach_delta.RED + budget.details.correction.coach_delta.BLACK, 0);
      assert.equal(budget.details.correction.note, 'Зачёт <октября>');
      assert.equal(budget.details.correction.reviewed, false);
    }
    const invalid = await post('/budgets/11-2026/correction-review', { note: 'x'.repeat(501) });
    assert.match(decodeURIComponent(invalid.headers.location!), /не длиннее 500 символов/);
    for (const id of budgetIds) {
      const saved = (await db.query<{details:{correction:typeof correction}}>('select details from budgets where id=$1',[id])).rows[0]!;
      assert.equal(saved.details.correction.reviewed, false);
      assert.equal(saved.details.correction.note, 'Зачёт <октября>');
    }
    const unconfirmedPage = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.equal(parse(unconfirmedPage.body).querySelector('[data-correction-confirm]')!.hasAttribute('disabled'), false);
    await post('/budgets/11-2026/correction-review', { note: '  Уточнённый зачёт <октября>  ' });
    for (const id of budgetIds) {
      const details = (await db.query<{ details: { correction: typeof correction } }>(
        'select details from budgets where id=$1', [id],
      )).rows[0]!.details;
      assert.equal(details.correction.reviewed, true);
      assert.equal(details.correction.note, 'Уточнённый зачёт <октября>');
      const savedCharges = (await db.query<{amount:number}>('select amount from charges where budget_id=$1',[id])).rows;
      assert.equal(Number(savedCharges[0]!.amount),72500);
    }
    const preview = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.match(preview.body, /Уточнённый зачёт &lt;октября&gt;/);
    assert.match(preview.body, /Подтверждено/);
    const confirmedForm = parse(preview.body).querySelector('form[action$="correction-review"]')!;
    assert.equal(confirmedForm.querySelector('button')!.hasAttribute('disabled'), true);
    // Editing enables confirmation and blocks publication; reverting restores both states.
    const handler = confirmedForm.querySelector('textarea')!.getAttribute('oninput')!;
    const confirmButton = { disabled: true };
    const status = { textContent: '' };
    const publishButton = { disabled: false, dataset: { ready: 'true' } };
    const field = { value: 'Новый комментарий', defaultValue: 'Уточнённый зачёт <октября>',
      form: { dataset: { reviewed: 'true' }, querySelector: (selector:string) => selector === '[data-correction-confirm]' ? confirmButton : status } };
    const input = () => runInNewContext('(function(){' + handler + '}).call(field)', {
      field, document: { querySelectorAll: () => [publishButton] },
    });
    input();
    assert.equal(confirmButton.disabled, false);
    assert.equal(publishButton.disabled, true);
    field.value = field.defaultValue;
    input();
    assert.equal(confirmButton.disabled, true);
    assert.equal(publishButton.disabled, false);
    field.form.dataset.reviewed = 'false';
    publishButton.dataset.ready = 'false';
    input();
    assert.equal(confirmButton.disabled, false);
    assert.equal(publishButton.disabled, true);
    // Published months remain immutable through the combined action.
    await db.query('update budgets set message_id=100 where id=$1',[budgetIds[0]]);
    const locked = await post('/budgets/11-2026/correction-review', { note: 'Не применять' });
    assert.match(decodeURIComponent(locked.headers.location!), /Опубликованный бюджет нельзя изменить/);
    for (const id of budgetIds) assert.match((await renderBudgetFromDb(id))!.text, /Уточнённый зачёт &lt;октября&gt;/);
  } finally {
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
