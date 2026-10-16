import cron from 'node-cron';
import { env } from '../config/env.js';
import { getBackupConfig, type BackupConfig } from '../db/repos/backupConfig.repo.js';
import { runBackup } from '../services/backup.service.js';
import { log } from '../util/logger.js';

export function backupCron(c: BackupConfig): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(c.run_time);
  if (!match) throw new Error('Неверное время резервного копирования');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (c.frequency === 'daily') return `${minute} ${hour} * * *`;
  if (c.frequency === 'weekly' && c.weekday >= 1 && c.weekday <= 7) {
    return `${minute} ${hour} * * ${c.weekday === 7 ? 0 : c.weekday}`;
  }
  if (c.frequency === 'monthly' && c.month_day >= 1 && c.month_day <= 28) {
    return `${minute} ${hour} ${c.month_day} * *`;
  }
  throw new Error('Неверная периодичность резервного копирования');
}

let task: ReturnType<typeof cron.schedule> | null = null;
let currentKey = '';

export async function reloadBackupScheduler(): Promise<void> {
  const config = await getBackupConfig();
  const nextKey = config.enabled ? `${backupCron(config)}|${env.TZ}` : 'off';
  if (nextKey === currentKey) return;
  task?.stop();
  task = null;
  if (config.enabled) {
    const expression = backupCron(config);
    task = cron.schedule(expression, () => {
      void runBackup()
        .then((name) => log.info(`[backup] создан ${name}`))
        .catch((err) => log.error('[backup] ошибка:', (err as Error).message));
    }, { timezone: env.TZ });
    log.info(`[backup] расписание активно: ${expression}, TZ=${env.TZ}`);
  } else {
    log.info('[backup] автоматическое резервное копирование выключено');
  }
  currentKey = nextKey;
}

export async function startBackupScheduler(): Promise<void> {
  await reloadBackupScheduler();
}
