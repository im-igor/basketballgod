import { query } from '../pool.js';

export interface BackupConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number;
  month_day: number;
  run_time: string;
  subdir: string;
  keep_count: number;
  last_success_at: Date | null;
  last_error: string | null;
}

const COLUMNS = 'enabled, frequency, weekday, month_day, run_time, subdir, keep_count, last_success_at, last_error';

export async function getBackupConfig(): Promise<BackupConfig> {
  const { rows } = await query<BackupConfig>(`select ${COLUMNS} from backup_config where id = 1`);
  if (!rows[0]) throw new Error('backup_config не инициализирован — запусти миграции');
  return rows[0];
}

export async function updateBackupConfig(c: Pick<BackupConfig, 'enabled' | 'frequency' | 'weekday' | 'month_day' | 'run_time' | 'subdir' | 'keep_count'>): Promise<void> {
  await query(
    `update backup_config set enabled=$1, frequency=$2, weekday=$3, month_day=$4,
       run_time=$5, subdir=$6, keep_count=$7, updated_at=now() where id=1`,
    [c.enabled, c.frequency, c.weekday, c.month_day, c.run_time, c.subdir, c.keep_count],
  );
}

export async function recordBackupResult(error: string | null): Promise<void> {
  await query(
    `update backup_config set last_success_at=case when $1::text is null then now() else last_success_at end,
       last_error=$1 where id=1`,
    [error],
  );
}
