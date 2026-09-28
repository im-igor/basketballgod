import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarHorizonEnd } from './dates.js';

test('горизонт включает целиком последний календарный день по Москве', () => {
  const startedAt = new Date('2026-09-27T18:00:00.913Z'); // 21:00 по Москве
  const until = calendarHorizonEnd(startedAt, 7, 'Europe/Moscow');
  assert.equal(until.toISOString(), '2026-10-04T21:00:00.000Z'); // 05.10 00:00 по Москве
  assert.ok(new Date('2026-10-04T18:10:00.000Z') < until); // игра 04.10 в 21:10
});

test('граница календарного горизонта учитывает переход на летнее время', () => {
  const startedAt = new Date('2026-03-22T20:00:00.000Z');
  const until = calendarHorizonEnd(startedAt, 7, 'Europe/Berlin');
  assert.equal(until.toISOString(), '2026-03-29T22:00:00.000Z'); // 30.03 00:00 CEST
});
