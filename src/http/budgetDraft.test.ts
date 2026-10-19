import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Bot } from 'grammy';

test('админка показывает тот же черновик и выполняет правки до публикации', async () => {
  const [{ pool }, { migrate }, { buildServer }, { draftKeyboard, renderBudgetFromDb, sendBudgetToChat }] = await Promise.all([
    import('../db/pool.js'), import('../db/migrator.js'), import('./server.js'), import('../services/notify.service.js'),
  ]);
  const db = new PGlite();
  const sql = (text: string, params?: unknown[]) => params
    ? db.query(text, params)
    : db.exec(text).then((results) => results.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release: () => undefined }));
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await migrate();
    const redPlayer = (await db.query<{ id: number }>(
      "insert into players (name, tg_login, team, is_employee) values ('Игрок Ред', '@redplayer', 'RED', true) returning id",
    )).rows[0]!.id;
    const blackPlayer = (await db.query<{ id: number }>(
      "insert into players (name, tg_login, team, is_employee, tg_user_id) values ('Игрок Блэк', '@blackplayer', 'BLACK', true, 123) returning id",
    )).rows[0]!.id;
    const details = (team: 'RED' | 'BLACK') => JSON.stringify({
      total_players: 2, players_team: 1, players_other: 1, paid_gym_sessions: 0,
      coach_sessions: team === 'RED' ? 2 : 0, gym_per_person: 0,
      coach_per_person: 5000, base_per_person: 5000,
      coach_shared_sessions: { RED: 2, BLACK: 0 },
    });
    const redBudget = (await db.query<{ id: number }>(
      'insert into budgets (team, month, year, total_per_player, details) values ($1,11,2026,5000,$2) returning id',
      ['RED', details('RED')],
    )).rows[0]!.id;
    const blackBudget = (await db.query<{ id: number }>(
      'insert into budgets (team, month, year, total_per_player, details) values ($1,11,2026,5000,$2) returning id',
      ['BLACK', details('BLACK')],
    )).rows[0]!.id;
    await db.query(
      'insert into charges (budget_id, player_id, tg_login, name, base_amount, amount, paid) values ($1,$2,$3,$4,5000,5000,true)',
      [redBudget, redPlayer, '@redplayer', 'Игрок Ред'],
    );
    await db.query(
      'insert into charges (budget_id, player_id, tg_login, name, base_amount, amount) values ($1,$2,$3,$4,5000,5000)',
      [blackBudget, blackPlayer, '@blackplayer', 'Игрок Блэк'],
    );
    let membership: 'member' | 'left' | 'error' = 'member';
    const sent: unknown[][] = [];
    const edited: unknown[][] = [];
    const api = {
      getChatMember: async () => {
        if (membership === 'error') throw new Error('Тестовая ошибка Telegram');
        return { status: membership };
      },
      sendMessage: async (...args: unknown[]) => { sent.push(args); return { message_id: 100 + sent.length }; },
      editMessageText: async (...args: unknown[]) => { edited.push(args); return {}; },
    };
    app = await buildServer({ api } as unknown as Bot);
    const login = await app.inject({ method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=test&password=test-password' });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const post = (url: string, values: Record<string, string>) => app!.inject({
      method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(values).toString(),
    });

    const privateDraft = await renderBudgetFromDb(redBudget, { api: api as never });
    const preview = await app.inject({ method: 'GET', url: '/budgets?month=11&year=2026', headers: { cookie } });
    assert.equal(preview.statusCode, 200);
    assert.ok(preview.body.includes(privateDraft!.text));
    assert.match(preview.body, /🟡Ред Игрок/);
    assert.match(preview.body, /бот ещё не знает Telegram ID игрока/);
    membership = 'left';
    assert.match((await renderBudgetFromDb(blackBudget, { api: api as never }))!.text, /🚫Блэк Игрок/);
    membership = 'error';
    assert.match((await renderBudgetFromDb(blackBudget, { api: api as never }))!.text, /⚠️Блэк Игрок/);
    membership = 'member';

    const page = await app.inject({ method: 'GET', url: '/budgets/11-2026', headers: { cookie } });
    assert.match(page.body, /Тренер −/);
    assert.match(page.body, /Тренер \+/);
    assert.match(page.body, /Сохранить комментарий/);
    assert.match(page.body, /\+ Товарищеский/);
    assert.match(page.body, /убрать посл\./);
    assert.match(page.body, /Базовый взнос общий для Red и Black/);
    assert.match(page.body, /общий взнос тренера: 5000₽/);
    assert.doesNotMatch(page.body, /action="\/charges\/\d+\/pay"/);
    assert.doesNotMatch(page.body, /Напомнить должникам/);

    const collections = await app.inject({ method: 'GET', url: '/collections', headers: { cookie } });
    assert.equal(collections.statusCode, 200);
    assert.match(collections.body, /2<\/b> участников · <b>1<\/b> сдали · <b>1<\/b> не сдали/);
    assert.match(collections.body, /href="\/collections\/11-2026"/);
    assert.match(collections.body, /action="\/collections\/11-2026\/debtors"/);
    const collection = await app.inject({ method: 'GET', url: '/collections/11-2026', headers: { cookie } });
    assert.equal(collection.statusCode, 200);
    assert.match(collection.body, /action="\/charges\/\d+\/pay"/);
    assert.doesNotMatch(collection.body, /Тренер −/);
    assert.doesNotMatch(collection.body, /Товарищеский матч/);
    const blackChargeId = (await db.query<{ id: number }>(
      'select id from charges where budget_id=$1', [blackBudget],
    )).rows[0]!.id;
    const paidResponse = await post(`/charges/${blackChargeId}/pay`, { value: 'yes' });
    assert.match(String(paidResponse.headers.location), new RegExp(`/collections/11-2026\\?msg=.*#charge-${blackChargeId}$`));
    assert.match((await app.inject({ method: 'GET', url: '/collections', headers: { cookie } })).body,
      /2<\/b> участников · <b>2<\/b> сдали · <b>0<\/b> не сдали/);
    await post(`/charges/${blackChargeId}/pay`, { value: 'no' });

    const coachUpdate = await post('/budgets/11-2026/coach', { team: 'RED', change: '-1' });
    assert.match(decodeURIComponent(String(coachUpdate.headers.location)), /Поправка/);
    let redCharge = (await db.query<{ amount: number; paid: boolean }>(
      'select amount, paid from charges where budget_id=$1', [redBudget],
    )).rows[0]!;
    assert.equal(Number(redCharge.amount), 2500);
    assert.equal(redCharge.paid, true);
    assert.equal(Number((await db.query<{ amount: number }>(
      'select amount from charges where budget_id=$1', [blackBudget],
    )).rows[0]!.amount), 2500);

    await post('/budgets/11-2026/coach-note', { team: 'RED', note: 'Зачёт отменённой тренировки' });
    const note = (await db.query<{ details: { coach_note: string } }>(
      'select details from budgets where id=$1', [redBudget],
    )).rows[0]!.details.coach_note;
    assert.equal(note, 'Зачёт отменённой тренировки');
    assert.match((await renderBudgetFromDb(redBudget))!.text, /Зачёт отменённой тренировки/);
    assert.match((await renderBudgetFromDb(blackBudget))!.text, /Зачёт отменённой тренировки/);

    await post('/budgets/11-2026/friendly', {
      opponent: 'Соседи', logins: '@redplayer, @blackplayer', coach: 'yes',
    });
    assert.equal((await db.query<{ count: number }>(
      "select count(*)::int as count from games where month=11 and year=2026 and team='MIXED'",
    )).rows[0]!.count, 1);
    const friendlyFee = (await db.query<{ fee_per_player: number }>(
      "select fee_per_player from games where month=11 and year=2026 and team='MIXED'",
    )).rows[0]!.fee_per_player;
    assert.equal(Number((await db.query<{ amount: number }>(
      'select amount from charges where budget_id=$1', [blackBudget],
    )).rows[0]!.amount), 2500 + Number(friendlyFee));

    await post('/budgets/11-2026/friendly/delete-last', {});
    assert.equal((await db.query<{ count: number }>(
      "select count(*)::int as count from games where month=11 and year=2026 and team='MIXED'",
    )).rows[0]!.count, 0);
    assert.equal(Number((await db.query<{ amount: number }>(
      'select amount from charges where budget_id=$1', [blackBudget],
    )).rows[0]!.amount), 2500);

    await post('/budgets/11-2026/coach', { team: 'RED', change: '1' });
    redCharge = (await db.query<{ amount: number; paid: boolean }>(
      'select amount, paid from charges where budget_id=$1', [redBudget],
    )).rows[0]!;
    assert.equal(Number(redCharge.amount), 5000);
    assert.equal(redCharge.paid, true);

    const readyDetails = (await db.query<{ details: Record<string, unknown> }>(
      'select details from budgets where id=$1', [blackBudget],
    )).rows[0]!.details;
    const staleDetails = { ...readyDetails };
    delete staleDetails.coach_shared_sessions;
    await db.query('update budgets set details=$2 where id=$1', [blackBudget, JSON.stringify(staleDetails)]);
    await assert.rejects(sendBudgetToChat(api as never, redBudget), /Пересобери бюджеты обеих команд/);
    await db.query('update budgets set details=$2 where id=$1', [blackBudget, JSON.stringify(readyDetails)]);

    const published = await post('/budgets/publish', { month: '11', year: '2026' });
    assert.match(decodeURIComponent(String(published.headers.location)), /Сборы отправлены/);
    assert.equal(sent.length, 2);
    assert.equal(draftKeyboard(redBudget, 'RED', true).inline_keyboard.flat().some((button) => button.callback_data?.startsWith('budpub:')), false);
    const publishedAgain = await post('/budgets/publish', { month: '11', year: '2026' });
    assert.match(decodeURIComponent(String(publishedAgain.headers.location)), /Нет неопубликованных/);
    assert.equal(sent.length, 2);
    await assert.rejects(sendBudgetToChat(api as never, redBudget), /уже опубликован/);
    const reminder = await post('/collections/11-2026/debtors', {});
    assert.match(decodeURIComponent(String(reminder.headers.location)), /\/collections\?msg=Напоминание отправлено/);
    assert.equal(sent.length, 3);
    assert.match(String(sent[2]![1]), /Должники/);

    const lateUpdate = await post('/budgets/11-2026/coach', { team: 'RED', change: '-1' });
    assert.match(decodeURIComponent(String(lateUpdate.headers.location)), /Поправка/);
    assert.equal(edited.length, 2);
    assert.deepEqual(new Set(edited.map((item) => item[0])), new Set([-1, -2]));
    redCharge = (await db.query<{ amount: number; paid: boolean }>(
      'select amount, paid from charges where budget_id=$1', [redBudget],
    )).rows[0]!;
    assert.equal(Number(redCharge.amount), 2500);
    assert.equal(redCharge.paid, true);
    assert.equal(Number((await db.query<{ amount: number }>(
      'select amount from charges where budget_id=$1', [blackBudget],
    )).rows[0]!.amount), 2500);
  } finally {
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
