import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLastDayOfMonthInTimeZone, scheduleImportCron, weeklyCron } from './cron.js';

test('пятница 15:50 преобразуется в ожидаемое расписание', () => {
  assert.equal(weeklyCron('15:50', 5, 'fallback'), '50 15 * * 5');
});

test('интервалы проверки расписаний преобразуются в cron', () => {
  assert.equal(scheduleImportCron(15), '*/15 * * * *');
  assert.equal(scheduleImportCron(60), '0 * * * *');
  assert.equal(scheduleImportCron(120), '0 */2 * * *');
  assert.equal(scheduleImportCron(720), '0 */12 * * *');
  assert.equal(scheduleImportCron(1440), '0 3 * * *');
  assert.throws(() => scheduleImportCron(45), /Неподдерживаемый интервал/);
});

test('определяет последний день месяца в таймзоне планировщика', () => {
  assert.equal(
    isLastDayOfMonthInTimeZone(new Date('2026-10-31T20:55:00Z'), 'Europe/Moscow'),
    true,
  );
  assert.equal(
    isLastDayOfMonthInTimeZone(new Date('2026-10-30T20:55:00Z'), 'Europe/Moscow'),
    false,
  );
});

test('учитывает високосный февраль', () => {
  assert.equal(
    isLastDayOfMonthInTimeZone(new Date('2028-02-29T20:55:00Z'), 'Europe/Moscow'),
    true,
  );
});
