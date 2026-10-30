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
  assert.deepEqual(diff.removed_dates, ['2026-10-22']);

  const suggested = proposeCorrection(10, 2026, red, black, current, {
    ...tariffs, coach_per_session: 7000, gym_paid_price: 30000,
  });
  assert.equal(suggested.coach_rate, 5000);
  assert.equal(suggested.gym_rate, 25500);
  assert.equal(suggested.reviewed, false);
  assert.deepEqual(suggested.source_snapshot, snapshotEvents(current, tariffs).events);
  assert.equal(suggested.note, '-1 сессия тренера, -1 аренда зала - за отмену 22.10.2026');

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
  '-2 сессии тренера, -1 аренда зала - за отмену в октябре 2026');
  assert.equal(correctionNote({ source_month: 10, source_year: 2026,
    coach_delta: { RED: 1, BLACK: -1 }, gym_delta: -1 }),
  '-1 аренда зала - за отмену в октябре 2026');
});

test('автокомментарий показывает даты отменённых тренировок по возрастанию', () => {
  const tuesday = { ...event('red-tue', 'RED', false), start: '2026-10-20T19:00:00+03:00' };
  const thursday = event('red-thu', 'RED', true);
  const from = [thursday, tuesday];
  const snapshot = snapshotEvents(from, tariffs);
  const red = budget('RED', snapshot);
  const black = budget('BLACK', snapshot);
  assert.equal(proposeCorrection(10, 2026, red, black, [thursday], tariffs).note,
    '-1 сессия тренера - за отмену 20.10.2026');
  assert.equal(proposeCorrection(10, 2026, red, black, [tuesday], tariffs).note,
    '-1 сессия тренера, -1 аренда зала - за отмену 22.10.2026');
  const both = proposeCorrection(10, 2026, red, black, [], tariffs);
  assert.deepEqual(both.source_removed_dates, ['2026-10-20', '2026-10-22']);
  assert.equal(both.note, '-2 сессии тренера, -1 аренда зала - за отмену 20.10.2026, 22.10.2026');
});

test('старый черновик получает даты из сохранённого списка изменений', () => {
  assert.equal(correctionNote({ source_month: 10, source_year: 2026,
    coach_delta: { RED: -1, BLACK: 0 }, gym_delta: -1,
    source_changes: ['2026-10-22 RED: отменено или изменено'],
  }), '-1 сессия тренера, -1 аренда зала - за отмену 22.10.2026');
  assert.equal(correctionNote({ source_month: 10, source_year: 2026,
    coach_delta: { RED: 0, BLACK: -5 }, gym_delta: 0,
  }), '-5 сессий тренера - за отмену в октябре 2026');
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
