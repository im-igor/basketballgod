import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBudgets } from './budget.js';
import type { Player, Team } from '../db/types.js';

const player = (id: number, team: Team): Player => ({
  id, team, name: `Игрок ${id}`, tg_login: `@player${id}`, tg_user_id: null,
  is_employee: true, active: true, active_from: null, active_to: null, notes: null,
});

test('до ноября-2026 тренер делится по командам, затем между всеми игроками', () => {
  const input = {
    year: 2026,
    tariffs: {
      coach_per_session: 5000, coach_per_game: 0, gym_paid_price: 3000,
      locker_rent_price: 0, referee_default: 0,
    },
    events: [
      { team: 'RED' as const, uid: 'r1', tags: { TYPE: 'TRAINING', COACH: 'PAID', GYM: 'PAID' } },
      { team: 'RED' as const, uid: 'r2', tags: { TYPE: 'TRAINING', COACH: 'PAID' } },
    ],
    active: { RED: [player(1, 'RED'), player(2, 'RED')], BLACK: [player(3, 'BLACK')] },
    games: [],
  };
  const october = computeBudgets({ ...input, month: 10 });
  assert.equal(october.RED.base_per_person, 6000);
  assert.equal(october.BLACK.base_per_person, 1000);

  const november = computeBudgets({ ...input, month: 11 });
  assert.equal(november.RED.base_per_person, 4334);
  assert.equal(november.BLACK.base_per_person, 4334);
});
