import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { backupCron } from './backup.js';
import type { BackupConfig } from '../db/repos/backupConfig.repo.js';

const config: BackupConfig = {
  enabled: true, frequency: 'weekly', weekday: 1, month_day: 1,
  run_time: '04:12', subdir: '', keep_count: 2,
  last_success_at: null, last_error: null,
};

test('расписание бэкапов соответствует выбранной периодичности', () => {
  assert.equal(backupCron(config), '12 4 * * 1');
  assert.equal(backupCron({ ...config, weekday: 7 }), '12 4 * * 0');
  assert.equal(backupCron({ ...config, frequency: 'daily' }), '12 4 * * *');
  assert.equal(backupCron({ ...config, frequency: 'monthly', month_day: 28 }), '12 4 28 * *');
  assert.throws(() => backupCron({ ...config, run_time: '24:00' }), /Неверное время/);
});
