import '../test/env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pool } from './pool.js';
import { migrate } from './migrator.js';
import { getMonthlyPayout, saveMonthlyPayout } from './repos/monthlyPayouts.repo.js';

test('миграция исправляет месяцы игр в сохранённых выплатах, сохраняя тарифы и остальные начисления', async () => {
  const db = new PGlite();
  const sql = async (text: string, params?: unknown[]) => params ? db.query(text, params) : (await db.exec(text)).at(-1)!;
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release() {} }));
  try {
    await migrate();
    await db.exec(`insert into games(team,opponent,played_on,month,year,coach_present,participants) values
      ('RED','Сентябрь','2026-09-30',10,2026,true,'[]'),
      ('BLACK','Октябрь','2026-10-01',11,2026,true,'[]'),
      ('MIXED','Октябрь MIXED','2026-10-31',11,2026,true,'[]'),
      ('RED','Без тренера','2026-10-15',11,2026,false,'[]'),
      ('BLACK','Декабрь','2026-12-31',1,2027,true,'[]'),
      ('BLACK','Январь','2027-01-01',2,2027,true,'[]')`);
    const nonGameItems = [
      { kind: 'TRAINING' as const, date: '2026-10-15', label: 'Тренировка', amount: 6000 },
      { kind: 'ADJUSTMENT' as const, date: null, label: 'Поправка', amount: -1000 },
    ];
    const october = await saveMonthlyPayout({
      month: 10, year: 2026, coach_amount: 10000, gym_amount: 75000,
      coach_training_sessions: 1, coach_games: 1, paid_gym_sessions: 5,
      coach_per_session: 6000, coach_per_game: 5000, gym_paid_price: 15000, locker_rent_price: 0,
      coach_items: [{ kind: 'GAME', date: '2026-09-30', label: 'Игра с Сентябрь', amount: 5000, team: 'RED' }, ...nonGameItems],
      gym_items: [{ kind: 'GYM', date: '2026-10-01', label: 'Зал', amount: 75000 }],
      corrections: [],
    });
    for (const [month, year] of [[9, 2026], [11, 2026], [12, 2026], [1, 2027]]) {
      await saveMonthlyPayout({ ...october, month: month!, year: year!, coach_amount: 0, coach_games: 0, coach_items: [] });
    }
    await db.exec(`update monthly_payouts set calculated_at='2026-10-31T20:55:00Z', notified_at='2026-10-31T20:56:00Z';
      update tariffs set coach_per_game=99999`);
    const before = (await db.query('select * from monthly_payouts where month=10')).rows[0]!;
    const gamesBefore = (await db.query('select * from games order by id')).rows;
    const migration = await readFile(new URL('./migrations/0020_payout_game_calendar_month.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const repaired = (await getMonthlyPayout(10, 2026))!;
    assert.equal(Number(repaired.coach_amount), 15000);
    assert.equal(repaired.coach_games, 2);
    assert.deepEqual(repaired.coach_items.filter(i => i.kind !== 'GAME'), nonGameItems);
    assert.deepEqual(repaired.coach_items.filter(i => i.kind === 'GAME'), [
      { kind: 'GAME', date: '2026-10-01', label: 'Игра с Октябрь', amount: 5000, team: 'BLACK' },
      { kind: 'GAME', date: '2026-10-31', label: 'Игра с Октябрь MIXED', amount: 5000 },
    ]);
    const after = (await db.query('select * from monthly_payouts where month=10')).rows[0]!;
    for (const key of Object.keys(before).filter(k => !['coach_amount', 'coach_games', 'coach_items', 'calculated_at'].includes(k))) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.notDeepEqual(after.calculated_at, before.calculated_at);
    assert.equal(Number((await getMonthlyPayout(9, 2026))!.coach_amount), 5000);
    assert.equal(Number((await getMonthlyPayout(11, 2026))!.coach_amount), 0);
    assert.equal((await getMonthlyPayout(12, 2026))!.coach_items[0]!.date, '2026-12-31');
    assert.equal((await getMonthlyPayout(1, 2027))!.coach_items[0]!.date, '2027-01-01');
    assert.deepEqual((await db.query('select * from games order by id')).rows, gamesBefore);
    const once = (await db.query('select * from monthly_payouts order by year,month')).rows;
    await db.exec(migration);
    assert.deepEqual((await db.query('select * from monthly_payouts order by year,month')).rows, once);
  } finally {
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});
