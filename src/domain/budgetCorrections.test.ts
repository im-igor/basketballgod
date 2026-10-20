import '../test/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Budget, Tariffs } from '../db/types.js';
import type { CalendarEvent } from '../google/calendar.js';
import { calendarDifference, correctionNote, payoutCorrections, proposeCorrection, snapshotEvents } from './budgetCorrections.js';

const tariffs: Tariffs = {
  coach_per_session: 5000, coach_per_game: 5000,
  gym_paid_price: 25500, locker_rent_price: 3000, referee_default: 3500,
};
const event = (uid: string, team: 'RED' | 'BLACK', paidGym: boolean): CalendarEvent => ({
  uid, team, summary: 'Тренировка', location: null,
  start: '2026-10-22T19:00:00+03:00', startDateTime: true,
  tags: { TYPE: 'TRAINING', COACH: 'PAID', GYM: paidGym ? 'PAID' : 'FREE' },
});
const budget = (team: 'RED' | 'BLACK', snapshot: ReturnType<typeof snapshotEvents>): Budget => ({
  id: team === 'RED' ? 1 : 2, team, month: 10, year: 2026,
  chat_id: -1, message_id: 100, total_per_player: 1000,
  details: {
    total_players: 10, players_team: 5, players_other: 5,
    paid_gym_sessions: 1, coach_sessions: 1,
    gym_per_person: 2550, coach_per_person: 500, base_per_person: 3050,
    event_snapshot: snapshot,
  },
});

test('отмена октябрьской тренировки предлагает отдельный зачёт и поясняет октябрьские начисления', () => {
  const original = [event('red-1', 'RED', true), event('black-1', 'BLACK', false)];
  const current = [original[1]!];
  const snapshot = snapshotEvents(original, tariffs);
  const red = budget('RED', snapshot);
  const black = budget('BLACK', snapshot);
  const diff = calendarDifference(red, black, current);
  assert.deepEqual(diff.coach_delta, { RED: -1, BLACK: 0 });
  assert.equal(diff.gym_delta, -1);
  assert.match(diff.changed[0]!, /2026-10-22 RED/);

  const suggested = proposeCorrection(10, 2026, red, black, current, {
    ...tariffs, coach_per_session: 7000, gym_paid_price: 30000,
  });
  assert.equal(suggested.coach_rate, 5000);
  assert.equal(suggested.gym_rate, 25500);
  assert.equal(suggested.reviewed, false);
  assert.deepEqual(suggested.source_snapshot, snapshotEvents(current, tariffs).events);
  assert.equal(suggested.note, 'Корректировка за Октябрь 2026: тренер -1, зал -1.');

  const payout = payoutCorrections(red, black, current, tariffs);
  assert.deepEqual(payout.map((c) => c.amount), [-5000, -25500]);
});

test('перенос тренировки показывает старую и новую даты без изменения суммы', () => {
  const original = [event('red-1', 'RED', true)];
  const moved = [{ ...original[0]!, start: '2026-10-23T19:00:00+03:00' }];
  const snapshot = snapshotEvents(original, tariffs);
  const diff = calendarDifference(budget('RED', snapshot), budget('BLACK', snapshot), moved);
  assert.deepEqual(diff.coach_delta, { RED: 0, BLACK: 0 });
  assert.equal(diff.gym_delta, 0);
  assert.match(diff.changed[0]!, /2026-10-22 RED: перенесено на 2026-10-23/);
});

test('автокомментарий складывает тренировки обеих команд без названий команд', () => {
  assert.equal(correctionNote({ source_month: 10, source_year: 2026,
    coach_delta: { RED: -1, BLACK: -1 }, gym_delta: -1 }),
  'Корректировка за Октябрь 2026: тренер -2, зал -1.');
  assert.equal(correctionNote({ source_month: 10, source_year: 2026,
    coach_delta: { RED: 1, BLACK: -1 }, gym_delta: -1 }),
  'Корректировка за Октябрь 2026: зал -1.');
});

test('старый опубликованный бюджет без снимка сравнивается по сохранённым количествам', () => {
  const snapshot = snapshotEvents([], tariffs);
  const red = budget('RED', snapshot);
  const black = budget('BLACK', snapshot);
  delete red.details!.event_snapshot;
  delete black.details!.event_snapshot;
  const diff = calendarDifference(red, black, [event('black-1', 'BLACK', false)]);
  assert.deepEqual(diff.coach_delta, { RED: -1, BLACK: 0 });
  assert.equal(diff.gym_delta, -1);
  assert.deepEqual(diff.changed, []);
});
