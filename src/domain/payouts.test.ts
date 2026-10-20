import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MonthlyPayout, Tariffs } from '../db/types.js';
import { buildMonthlyPayoutMessage, computeMonthlyPayouts } from './payouts.js';

const tariffs: Tariffs = {
  coach_per_session: 5000,
  coach_per_game: 4500,
  gym_paid_price: 25500,
  locker_rent_price: 3000,
  referee_default: 3500,
};

test('суммирует тренировки обеих команд и игры с тренером', () => {
  const result = computeMonthlyPayouts({
    coachTrainingSessions: { RED: 3, BLACK: 4 },
    coachDeltas: { BLACK: 1 },
    coachGames: 2,
    paidGymSessions: 4,
    tariffs,
  });

  assert.deepEqual(result, {
    coach: 49_000,
    gym: 105_000,
    coachTrainingSessions: 8,
    coachGames: 2,
    paidGymSessions: 4,
  });
});

test('не задваивает зал между бюджетами и применяет нижнюю границу к ручной правке', () => {
  const result = computeMonthlyPayouts({
    coachTrainingSessions: { RED: 1, BLACK: 2 },
    coachDeltas: { RED: -5 },
    coachGames: 0,
    paidGymSessions: 2,
    tariffs,
  });

  assert.equal(result.coach, 10_000);
  assert.equal(result.gym, 54_000);
  assert.equal(result.paidGymSessions, 2);
});

test('сообщение в личку содержит суммы и полную формулу', () => {
  const payout: MonthlyPayout = {
    month: 10,
    year: 2026,
    coach_amount: 49_000,
    gym_amount: 105_000,
    coach_training_sessions: 8,
    coach_games: 2,
    paid_gym_sessions: 4,
    coach_per_session: 5000,
    coach_per_game: 4500,
    gym_paid_price: 25_500,
    locker_rent_price: 3000,
    coach_items: [
      { kind: 'TRAINING', date: '2026-10-03', label: 'Тренировка <RED>', amount: 5000, team: 'RED' },
      { kind: 'GAME', date: '2026-10-05', label: 'Игра с Соколами', amount: 4500, team: 'BLACK' },
    ],
    gym_items: [
      { kind: 'GYM', date: '2026-10-03', label: 'Тренировка · Зал', amount: 25_500, team: 'BLACK' },
      { kind: 'LOCKER', date: null, label: 'Аренда шкафчика', amount: 3000 },
    ],
    calculated_at: new Date('2026-10-31T20:55:00Z'),
    notified_at: null,
  };

  const message = buildMonthlyPayoutMessage(payout);
  assert.match(message, /Начисления за Октябрь 2026/);
  assert.match(message, /Тренеру начислено: 49000 ₽/);
  assert.match(message, /03\.10\.2026 · RED · Тренировка &lt;RED&gt; — 5000 ₽/);
  assert.match(message, /05\.10\.2026 · BLACK · Игра с Соколами — 4500 ₽/);
  assert.match(message, /За зал начислено: 105000 ₽/);
  assert.match(message, /Аренда шкафчика — 3000 ₽/);
  const withCorrection = buildMonthlyPayoutMessage({
    ...payout,
    corrections: [{ component: 'GYM', sessions: -1, amount: -25500, note: 'Отменена 1 аренда' }],
  });
  assert.match(withCorrection, /Отменена 1 аренда: -25500 ₽/);
});
