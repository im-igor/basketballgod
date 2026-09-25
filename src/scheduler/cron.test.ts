import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleImportCron, weeklyCron } from './cron.js';

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
