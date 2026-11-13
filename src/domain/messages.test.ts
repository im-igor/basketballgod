import '../test/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBudgetMessage } from './messages.js';

test('общий бюджет Red и Black показывает единый расчёт зала и тренера', () => {
  const tariffs = {
    gym_paid_price: 15000, coach_per_session: 6000, locker_rent_price: 0,
    coach_per_game: 0, referee_default: 0,
  };
  const calculation = `Всего участников: 15 Black + 20 Red = 35 чел.\n` +
    `Зал по четвергам - 4 трен. (делится на всех)\n` +
    `4 x 15000 / 35 = 1715 руб.\n` +
    `Зал по вторникам - оплачивается Яндексом.\n` +
    `Тренер 8 трен.\n` +
    `8 x 6000 / 35 = 1372 руб.\n\n` +
    `ИТОГО: 3087 руб.`;

  for (const team of ['RED', 'BLACK'] as const) {
    const details = {
      total_players: 35, players_team: team === 'RED' ? 20 : 15,
      players_other: team === 'RED' ? 15 : 20, paid_gym_sessions: 4,
      coach_sessions: 4, gym_per_person: 1715, coach_per_person: 1372,
      base_per_person: 3087, coach_shared_sessions: { RED: 4, BLACK: 4 },
    };
    const message = buildBudgetMessage({
      team, month: 11, year: 2026, details, tariffs,
      charges: [], games: [], payment: { sberUrl: 'sber', tbankUrl: 'tbank' },
    });
    assert.ok(message.includes(calculation));
  }
});

test('единый COMMON-бюджет не указывает команды в строках про зал', () => {
  const message = buildBudgetMessage({
    team: 'COMMON', month: 12, year: 2026,
    details: {
      total_players: 37, players_team: 37, players_other: 0,
      paid_gym_sessions: 5, coach_sessions: 10,
      gym_per_person: 2028, coach_per_person: 1622, base_per_person: 3650,
      event_snapshot: {
        events: [
          ...Array.from({ length: 5 }, (_, i) => ({ uid: `red-${i}`, team: 'RED' as const, start: `2026-12-0${i + 1}`, paid_coach: true, paid_gym: false })),
          ...Array.from({ length: 5 }, (_, i) => ({ uid: `black-${i}`, team: 'BLACK' as const, start: `2026-12-1${i + 1}`, paid_coach: true, paid_gym: true })),
        ],
        coach_rate: 6000, gym_rate: 15000, locker_rate: 0,
      },
    },
    tariffs: {
      gym_paid_price: 15000, coach_per_session: 6000, locker_rent_price: 0,
      coach_per_game: 0, referee_default: 0,
    },
    charges: [], games: [], payment: { sberUrl: 'sber', tbankUrl: 'tbank' },
  });

  assert.match(message, /Всего участников: 37 чел\.\nЗал по четвергам - 5 трен\. \(делится на всех\)\n5 x 15000 \/ 37 = 2028 руб\.\nЗал по вторникам - 5 трен\. \(оплачивается Яндексом полностью\)\./);
  assert.doesNotMatch(message, /Зал (?:Black|Red) по/);
});
