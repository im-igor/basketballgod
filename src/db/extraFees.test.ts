import '../test/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { pool } from './pool.js';
import { migrate } from './migrator.js';
import { saveBudget, getBudget, getCharges, setChargePaid, deleteBudget } from './repos/budgets.repo.js';
import { createExtraFee, deleteUnusedExtraFee, listExtraFeeAllocations, setExtraFeeActive } from './repos/extraFees.repo.js';
import { saveGame } from './repos/games.repo.js';
import { saveMonthlyPayout } from './repos/monthlyPayouts.repo.js';
import { buildAndSaveBudgets, recalcBudget, updateBudgetCorrection } from '../services/budget.service.js';
import { calculateAndSaveMonthlyPayout } from '../services/monthlyPayout.service.js';
import { renderBudgetFromDb, sendBudgetToChat } from '../services/notify.service.js';
import { buildServer } from '../http/server.js';
import type { BudgetDetails, Team } from './types.js';
import type { Bot } from 'grammy';

const db = new PGlite();
const calendarItems = new Map<string, Array<{ id: string; summary: string; description: string; start: { dateTime: string } }>>();
const training = (id: string, month: number, team: Team, gym: 'PAID' | 'FREE' = 'FREE') => ({
  id, summary: `Тренировка ${team}`, description: `TYPE=TRAINING\nCOACH=PAID\nGYM=${gym}`,
  start: { dateTime: `2026-${String(month).padStart(2, '0')}-15T19:00:00+03:00` },
});
// Один PostgreSQL backend, как pool max=1: транзакции не перемешиваются.
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
  // Тот же numeric parser, что в production pg.Pool.
  for (const field of result.fields) if (field.dataTypeID === 1700) {
    for (const row of result.rows as Record<string, unknown>[]) {
      if (row[field.name] !== null) row[field.name] = Number(row[field.name]);
    }
  }
  return { ...result, rowCount: result.affectedRows || result.rows.length };
}

const details: BudgetDetails = {
  total_players: 4, players_team: 3, players_other: 1, paid_gym_sessions: 0,
  coach_sessions: 0, gym_per_person: 1000, coach_per_person: 0, base_per_person: 1000,
};
const feeInput = {
  title: 'Меддопуск', amount_per_player: 380, team: 'BLACK' as const,
  mode: 'PLAYED' as const, league: 'MLBL' as const, start_period: 202610, end_period: null,
};
const charge = (id: number) => ({ player_id: id, tg_login: `@p${id}`, name: `Игрок ${id}`, base_amount: 1000, game_amount: 0, amount: 1000 });
const save = (month = 10, team: Team = 'BLACK', ids = [1, 2, 3]) => saveBudget({
  team, month, year: 2026, total_per_player: 1000, details, charges: ids.map(charge),
});
async function game(month: number, ids: number[]) {
  await sql(`insert into games (team, stat_url, played_on, month, year, fee_per_player, participants)
    values ('BLACK', 'https://moscow.ilovebasket.ru/games/1090210', '2026-09-20', $1, 2026, 0, $2)`,
  [month, JSON.stringify(ids.map((id) => ({ name: `Игрок ${id}`, matched_player_id: id })))]);
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
  mock.method(calendar_v3.Resource$Events.prototype, 'list', async (args: { calendarId: string; timeMin: string }) => {
    const month = new Date(args.timeMin).getMonth() + 1;
    return { data: { items: calendarItems.get(`${args.calendarId}:${month}`) ?? [] } };
  });
  await migrate();
  await migrate(); // повторный старт не ломает схему
});
beforeEach(async () => {
  calendarItems.clear();
  await db.exec('truncate monthly_payouts, extra_fee_allocations, extra_fees, charges, budgets, games, players restart identity cascade');
  await db.exec(`insert into players (id, name, tg_login, team, active, is_employee) values
    (1, 'Игрок 1', '@p1', 'BLACK', true, true), (2, 'Игрок 2', '@p2', 'BLACK', true, true),
    (3, 'Игрок 3', '@p3', 'BLACK', true, true), (4, 'Игрок 4', '@p4', 'RED', true, true)`);
});

test('октябрьская отмена уменьшает начисления и отдельно зачитывается в ноябрьском сборе', async () => {
  calendarItems.set('test-red:10', [training('oct-red', 10, 'RED', 'PAID')]);
  calendarItems.set('test-black:10', [training('oct-black', 10, 'BLACK')]);
  await buildAndSaveBudgets(10, 2026);
  await sql('update budgets set message_id = id + 100 where month = 10 and year = 2026');
  calendarItems.set('test-red:10', []); // администратор удалил отменённую тренировку
  calendarItems.set('test-red:11', Array.from({ length: 4 }, (_, i) => training(`nov-red-${i}`, 11, 'RED')));
  calendarItems.set('test-black:11', Array.from({ length: 4 }, (_, i) => training(`nov-black-${i}`, 11, 'BLACK', 'PAID')));

  const built = await buildAndSaveBudgets(11, 2026);
  assert.equal(built.length, 2);
  const novemberRed = (await getBudget('RED', 11, 2026))!;
  const novemberBlack = (await getBudget('BLACK', 11, 2026))!;
  assert.deepEqual(novemberRed.details!.correction?.coach_delta, { RED: -1, BLACK: 0 });
  assert.equal(novemberRed.details!.correction?.gym_delta, -1);
  assert.equal(novemberRed.details!.correction?.reviewed, false);
  assert.equal(Number(novemberRed.total_per_player), 28625);
  assert.equal(Number(novemberBlack.total_per_player), 28625);
  assert.match((await renderBudgetFromDb(novemberBlack.id))!.text,
    /-1 сессия тренера, -1 аренда зала - за 15\.10\.2026/);
  const telegram = { sendMessage: async () => ({ message_id: 999 }) } as never;
  await assert.rejects(sendBudgetToChat(telegram, novemberRed.id), /Подтверди корректировки/);
  await updateBudgetCorrection(11, 2026, { ...novemberRed.details!.correction!, reviewed: true });
  calendarItems.set('test-red:10', [training('oct-new', 10, 'RED')]);
  await assert.rejects(sendBudgetToChat(telegram, novemberRed.id), /Календарь прошлого месяца изменился/);
  calendarItems.set('test-red:10', []);
  await sendBudgetToChat(telegram, novemberRed.id);
  assert.equal((await getBudget('RED', 11, 2026))!.message_id, 999);

  const payout = await calculateAndSaveMonthlyPayout(10, 2026);
  assert.equal(Number(payout.coach_amount), 5000);
  assert.equal(Number(payout.gym_amount), 3000);
  assert.deepEqual(payout.corrections.map((c) => c.amount), [-5000, -25500]);
});
after(async () => { mock.restoreAll(); await db.close(); await pool.end(); });

test('380 с сыгравших: первый месяц 1 и 2, следующий — только новый участник 3', async () => {
  await createExtraFee(feeInput);
  await game(10, [1, 2]);
  await game(11, [1, 3]);
  const october = await save();
  assert.deepEqual((await getCharges(october.id)).map((c) => c.extra_amount), [380, 380, 0]);
  const november = await save(11);
  assert.deepEqual((await getCharges(november.id)).map((c) => c.extra_amount), [0, 0, 380]);
  assert.equal((await listExtraFeeAllocations()).length, 3);
});

test('пересборка сохраняет id, paid, paid_at и единственное разовое начисление', async () => {
  await createExtraFee(feeInput);
  await game(10, [1]);
  const budget = await save();
  const first = (await getCharges(budget.id))[0]!;
  const paid = await setChargePaid(first.id, true);
  await save();
  const rebuilt = (await getCharges(budget.id))[0]!;
  assert.equal(rebuilt.id, first.id);
  assert.equal(rebuilt.amount, 1380);
  assert.equal(rebuilt.paid, true);
  assert.deepEqual(rebuilt.paid_at, paid!.paid_at);
  assert.equal((await listExtraFeeAllocations()).length, 1);
});

test('режим BUDGET включает всех выбранной команды без игр, только в одном месяце', async () => {
  await createExtraFee({ ...feeInput, mode: 'BUDGET', league: 'ANY' });
  const black = await save();
  const red = await save(10, 'RED', [4]);
  assert.deepEqual((await getCharges(black.id)).map((c) => c.extra_amount), [380, 380, 380]);
  assert.equal((await getCharges(red.id))[0]!.extra_amount, 0);
  assert.deepEqual((await getCharges((await save(11)).id)).map((c) => c.extra_amount), [0, 0, 0]);
});

test('игрок RED за BLACK: 380 в RED, после перехода команды повторно не начисляется', async () => {
  await createExtraFee(feeInput);
  await game(10, [4]);
  const red = await save(10, 'RED', [4]);
  assert.equal((await getCharges(red.id))[0]!.extra_amount, 380);
  const black = await save(10, 'BLACK', [1, 2, 3, 4]);
  assert.equal((await getCharges(black.id))[3]!.extra_amount, 0);
});

test('параллельные пересборки оставляют одно назначение на человека', async () => {
  await createExtraFee(feeInput);
  await game(10, [1]);
  await game(11, [1]);
  await Promise.all([save(10), save(11), save(10)]);
  assert.equal((await listExtraFeeAllocations()).length, 1);
  const budgets = await Promise.all([getBudget('BLACK', 10, 2026), getBudget('BLACK', 11, 2026)]);
  const charges = (await Promise.all(budgets.map((b) => getCharges(b!.id)))).flat();
  assert.equal(charges.reduce((sum, c) => sum + c.extra_amount, 0), 380);
});

test('ошибка записи откатывает бюджет, начисления и историю сборов вместе', async () => {
  await createExtraFee(feeInput);
  await game(10, [1]);
  const budget = await save();
  const before = await getCharges(budget.id);
  await assert.rejects(save(10, 'BLACK', [1, 999]), /foreign key/i);
  assert.deepEqual(await getCharges(budget.id), before);
  assert.equal((await listExtraFeeAllocations()).length, 1);
});

test('завершение останавливает новые начисления, сохраняя историю; удаление возможно только без начислений', async () => {
  const fee = await createExtraFee(feeInput);
  await game(10, [1]);
  await game(11, [2]);
  const october = await save();
  await setExtraFeeActive(fee.id, false);
  await save();
  assert.equal((await getCharges(october.id))[0]!.extra_amount, 380);
  assert.equal((await getCharges((await save(11)).id))[1]!.extra_amount, 0);
  assert.equal(await deleteUnusedExtraFee(fee.id), false);
  const unused = await createExtraFee({ ...feeInput, title: 'Ошибочный' });
  assert.equal(await deleteUnusedExtraFee(unused.id), true);
});

test('удаление бюджета освобождает назначения только этого бюджета', async () => {
  await createExtraFee(feeInput);
  await game(10, [1]);
  await game(11, [2]);
  await save();
  await save(11);
  await deleteBudget('BLACK', 10, 2026);
  assert.equal((await listExtraFeeAllocations()).length, 1);
  const rebuilt = await save();
  assert.equal((await getCharges(rebuilt.id))[0]!.extra_amount, 380);
  assert.equal((await listExtraFeeAllocations()).length, 2);
});

test('пересчёт тренера и рендер из БД сохраняют разовый взнос и оплату', async () => {
  await createExtraFee(feeInput);
  await game(10, [1]);
  const budget = await save();
  await setChargePaid((await getCharges(budget.id))[0]!.id, true);
  const result = await recalcBudget(budget.id, { coachDeltaChange: 1 });
  const first = (await getCharges(budget.id))[0]!;
  assert.equal(first.extra_amount, 380);
  assert.equal(first.amount, 1000 + Math.ceil(5000 / 3) + 380);
  assert.equal(first.paid, true);
  assert.match(result!.message, /Меддопуск \+380/);
  assert.match((await renderBudgetFromDb(budget.id))!.text, /Меддопуск \+380/);
});

test('полная сборка бюджета учитывает разовые суммы в БД, result и сообщении', async () => {
  await createExtraFee(feeInput);
  await game(10, [1, 4]);
  const built = await buildAndSaveBudgets(10, 2026);
  for (const b of built) {
    assert.equal(b.result.charges.filter((c) => c.extra_amount === 380).length, 1);
    assert.match(b.message, /Меддопуск \+380/);
    for (const c of b.result.charges) assert.equal(c.amount, c.base_amount + c.game_amount + c.extra_amount);
  }
  assert.equal((await listExtraFeeAllocations()).length, 2);
});

test('с ноября сборка одной команды обновляет общий взнос и сохраняет проверку чатов обеих команд', async () => {
  await sql('update players set tg_user_id = 101 where id = 1');
  await saveBudget({ team: 'RED', month: 11, year: 2026, total_per_player: 1000,
    details: { ...details, coach_delta: 2, coach_note: 'Перенос двух оплат' }, charges: [charge(4)] });
  await saveBudget({ team: 'BLACK', month: 11, year: 2026, total_per_player: 1000,
    details: { ...details, coach_delta: 1 }, charges: [charge(1), charge(2), charge(3)] });

  let checks = 0;
  const api = { getChatMember: async () => { checks++; return { status: 'left' }; } } as never;
  const built = await buildAndSaveBudgets(11, 2026, ['RED'], api);
  assert.equal(built.length, 1);
  const red = (await getBudget('RED', 11, 2026))!;
  const black = (await getBudget('BLACK', 11, 2026))!;
  assert.equal(red.total_per_player, 4500);
  assert.equal(black.total_per_player, 4500);
  assert.deepEqual(red.details!.coach_shared_sessions, { RED: 2, BLACK: 1 });
  assert.deepEqual(black.details!.coach_shared_sessions, { RED: 2, BLACK: 1 });
  assert.equal(red.details!.coach_shared_notes?.RED, 'Перенос двух оплат');
  assert.equal(checks, 1);
  assert.equal(red.details!.chat_check?.statuses['@p4'], 'missing_id');
  assert.equal(black.details!.chat_check?.statuses['@p1'], 'left');
  assert.equal(black.details!.chat_check?.statuses['@p2'], 'missing_id');
  assert.ok(red.details!.chat_check?.checked_at);
  assert.match((await renderBudgetFromDb(black.id, { savedChatStatus: true }))!.text, /🚫1 Игрок/);
  assert.equal((await getCharges(red.id))[0]!.base_amount, 4500);
  assert.ok((await getCharges(black.id)).every((c) => c.base_amount === 4500));
  await recalcBudget(black.id);
  assert.equal((await getBudget('BLACK', 11, 2026))!.details!.chat_check?.statuses['@p1'], 'left');
});

test('текст бюджета RED и BLACK: игры участников за обе команды, чемпионат и месяц начисления', async () => {
  const addGame = (ids: number[], patch: Partial<Parameters<typeof saveGame>[0]>) => saveGame({
    event_uid: null, team: 'BLACK', opponent: 'Jumpball Строгино', played_on: '2026-09-20',
    stat_url: 'https://moscow.ilovebasket.ru/games/1090210?lang=ru#protocol',
    fee_per_player: 556, month: 10, year: 2026, ...patch,
    participants: ids.map((id) => ({ name: `Игрок ${id}`, matched_player_id: id })),
  });
  await addGame([1, 4], {}); // Игрок RED выступил за BLACK.
  await addGame([2, 4], {
    team: 'RED', opponent: 'РТК-ЦОД', played_on: '2026-09-27', fee_per_player: 455,
    stat_url: 'https://basketball.businesschampions.ru/osen-2026/matches/123/',
  }); // Игрок BLACK выступил за RED.
  await addGame([3], { opponent: 'Только BLACK', played_on: '2026-09-25', fee_per_player: 200 });
  await addGame([4], {
    team: 'MIXED', opponent: 'Товарищеская <игра>', played_on: '2026-09-28',
    stat_url: null, fee_per_player: 100,
  });
  await addGame([4], {
    team: 'RED', opponent: 'Старый протокол', played_on: '2026-09-29',
    stat_url: 'invalid', fee_per_player: 0,
  });
  const emptyGame = await addGame([], { team: 'RED', opponent: 'Без участников бюджета' });
  await assert.rejects(buildAndSaveBudgets(10, 2026), /участники не попадут в бюджет/);
  await sql('delete from games where id=$1', [emptyGame.id]);
  await addGame([1, 4], { opponent: 'Другой месяц начисления', month: 9 });
  await addGame([1, 4], { opponent: 'Другой год начисления', year: 2025 });

  const expected: Record<Team, string[]> = {
    RED: [
      '20.09.2026 Jumpball Строгино (МЛБЛ) +556',
      '27.09.2026 РТК-ЦОД (ЛЧБ) +455',
      '28.09.2026 Товарищеская &lt;игра&gt; +100',
      '29.09.2026 Старый протокол +0',
    ],
    BLACK: [
      '20.09.2026 Jumpball Строгино (МЛБЛ) +556',
      '25.09.2026 Только BLACK (МЛБЛ) +200',
      '27.09.2026 РТК-ЦОД (ЛЧБ) +455',
    ],
  };
  const gameLines = (text: string) => text.split('\n').filter((line) => /^\d{2}\.\d{2}\.\d{4} /.test(line));
  const amounts = new Map([[1, 556], [2, 455], [3, 200], [4, 1111]]);
  const built = await buildAndSaveBudgets(10, 2026);
  // Повторный рендер опирается на сохранённый бюджет, даже если ростер уже изменился.
  await sql("update players set active = false, team = 'BLACK' where id = 4");
  for (const b of built) {
    assert.equal(b.gamesCount, expected[b.team].length);
    assert.deepEqual(gameLines(b.message), expected[b.team]);
    assert.deepEqual(gameLines((await renderBudgetFromDb(b.budgetId))!.text), expected[b.team]);
    assert.deepEqual(gameLines((await recalcBudget(b.budgetId))!.message), expected[b.team]);
    assert.deepEqual(gameLines((await renderBudgetFromDb(b.budgetId))!.text), expected[b.team]);
    for (const c of await getCharges(b.budgetId)) {
      assert.equal(c.game_amount, amounts.get(c.player_id!));
      assert.equal(c.amount, c.base_amount + c.game_amount);
    }
  }
});

test('админка: авторизация, валидация, создание, пересчёт, детализация и остановка сбора', async () => {
  const bot = { api: {} } as Bot; // ни одного вызова Telegram
  const app = await buildServer(bot);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/extra-fees' })).statusCode, 302);
    assert.equal((await app.inject({ method: 'POST', url: '/extra-fees', payload: {} })).statusCode, 302);
    const login = await app.inject({ method: 'POST', url: '/login', payload: { username: 'test', password: 'test-password' } });
    const cookies = { bbg_auth: login.cookies[0]!.value };
    const invalid = await app.inject({ method: 'POST', url: '/extra-fees', cookies, payload: { title: 'Нет суммы' } });
    assert.match(decodeURIComponent(invalid.headers.location!), /Проверь/);
    const create = await app.inject({ method: 'POST', url: '/extra-fees', cookies, payload: {
      title: 'Меддопуск <МЛБЛ>', amount_per_player: '380', team: 'BLACK', mode: 'PLAYED', league: 'MLBL', start_period: '2026-10', end_period: '',
    } });
    assert.equal(create.statusCode, 302);
    await game(10, [1]);
    await save();
    await saveMonthlyPayout({
      month: 10, year: 2026, coach_amount: 5000, gym_amount: 3000,
      coach_training_sessions: 0, coach_games: 1, paid_gym_sessions: 0,
      coach_per_session: 5000, coach_per_game: 5000,
      gym_paid_price: 25500, locker_rent_price: 3000,
      coach_items: [{ kind: 'GAME', date: '2026-10-10', label: 'Игра с Тестом', amount: 5000, team: 'BLACK' }],
      gym_items: [{ kind: 'LOCKER', date: null, label: 'Аренда шкафчика', amount: 3000 }],
    });
    const recalc = await app.inject({ method: 'POST', url: '/extra-fees/recalculate', cookies, payload: { period: '2026-10' } });
    assert.match(recalc.headers.location!, /budgets\?month=10/);
    const page = await app.inject({ method: 'GET', url: '/extra-fees', cookies });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Меддопуск &lt;МЛБЛ&gt;/);
    assert.match(page.body, /Начислено 1 чел\. \/ 380 ₽/);
    const budgetsPage = await app.inject({ method: 'GET', url: '/budgets?month=10&year=2026', cookies });
    assert.match(budgetsPage.body, /Разовые сборы за Октябрь 2026/);
    assert.match(budgetsPage.body, /активно: 1/);
    assert.match(budgetsPage.body, /Меддопуск &lt;МЛБЛ&gt; — 380 ₽\/чел\., сыгравшим, BLACK/);
    assert.doesNotMatch(budgetsPage.body, /История расчётов/);
    const previousMonth = await app.inject({ method: 'GET', url: '/budgets?month=9&year=2026', cookies });
    assert.match(previousMonth.body, /Для выбранного месяца активных разовых сборов нет/);
    assert.match(page.body, /href="\/budgets\/10-2026"/);
    const budgetPage = await app.inject({ method: 'GET', url: '/budgets/10-2026', cookies });
    assert.equal(budgetPage.statusCode, 200);
    assert.match(budgetPage.body, /Расчёты с тренером и залом/);
    assert.match(budgetPage.body, /Начислено тренеру — 5000₽/);
    assert.match(budgetPage.body, /Начислено за зал — 3000₽/);
    assert.match(budgetPage.body, /Игра с Тестом/);
    assert.match(budgetPage.body, /Аренда шкафчика/);
    assert.match(budgetPage.body, /Разовые/);
    assert.match(budgetPage.body, /Меддопуск &lt;МЛБЛ&gt;: \+380₽/);
    const stop = await app.inject({ method: 'POST', url: '/extra-fees/1/status', cookies, payload: { active: 'no' } });
    assert.equal(stop.statusCode, 302);
    const removed = await app.inject({ method: 'POST', url: '/extra-fees/1/delete', cookies });
    assert.match(decodeURIComponent(removed.headers.location!), /уже имеет начисления/);
  } finally { await app.close(); }
});
