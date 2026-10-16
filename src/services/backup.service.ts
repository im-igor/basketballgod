import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { getBackupConfig, recordBackupResult } from '../db/repos/backupConfig.repo.js';

const execFile = promisify(execFileCallback);
const ARCHIVE_NAME = /^basketballgod_\d{4}-\d{2}-\d{2}_(?:\d{4}|\d{6}|\d{9})\.tar\.gz$/;
const LOCK_ID = 20261016;

export interface BackupArchive { name: string; size: number; modified: Date }

export function backupHostRoot(): string {
  return resolve(env.BACKUP_HOST_ROOT || join(process.cwd(), 'basketballgod-backups'));
}

function backupMountRoot(): string {
  return resolve(env.BACKUP_MOUNT_ROOT || backupHostRoot());
}

/** Только хостовый корень и его подпапки доступны контейнеру. */
export function backupPaths(subdirOrHost: string | null): { host: string; local: string; subdir: string } {
  const root = backupHostRoot();
  const configured = subdirOrHost?.trim() || '';
  const host = configured ? (isAbsolute(configured) ? configured : join(root, configured)) : root;
  if (!isAbsolute(host) || host.includes('\0') || /[\r\n]/.test(host) || resolve(host) !== host) {
    throw new Error('Укажи нормализованный абсолютный путь на ВМ');
  }
  const rel = relative(root, host);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Путь должен находиться внутри ${root}`);
  }
  return { host, local: join(backupMountRoot(), rel), subdir: rel };
}

async function rejectSymlinks(local: string): Promise<void> {
  const root = backupMountRoot();
  const rel = relative(root, local);
  let current = root;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Символические ссылки в пути бэкапов запрещены');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}

export async function prepareBackupDirectory(hostPath: string | null): Promise<{ host: string; local: string; subdir: string }> {
  const paths = backupPaths(hostPath);
  await rejectSymlinks(paths.local);
  await mkdir(paths.local, { recursive: true, mode: 0o700 });
  await rejectSymlinks(paths.local);
  if (!(await stat(paths.local)).isDirectory()) throw new Error('Путь бэкапов не является папкой');
  await chmod(paths.local, 0o700);
  return paths;
}

export async function listBackupArchives(hostPath: string | null): Promise<BackupArchive[]> {
  const { local } = backupPaths(hostPath);
  await rejectSymlinks(local);
  let names: string[];
  try { names = await readdir(local); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const archives = await Promise.all(names.filter((name) => ARCHIVE_NAME.test(name)).map(async (name) => {
    const info = await lstat(join(local, name));
    return info.isFile() ? { name, size: info.size, modified: info.mtime } : null;
  }));
  return archives.filter((a): a is BackupArchive => a !== null).sort((a, b) => b.name.localeCompare(a.name));
}

export async function openBackupArchive(hostPath: string | null, name: string) {
  if (!ARCHIVE_NAME.test(name) || basename(name) !== name) return null;
  const { local } = backupPaths(hostPath);
  await rejectSymlinks(local);
  const handle = await open(join(local, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();
  if (!info.isFile()) { await handle.close(); return null; }
  return { stream: handle.createReadStream(), size: info.size };
}

async function createBackupFiles(work: string): Promise<void> {
  try {
    await execFile('pg_dump', ['--format=custom', `--file=${join(work, 'db.dump')}`], {
      env: { ...process.env, PGDATABASE: env.DATABASE_URL },
      timeout: 30 * 60_000,
      maxBuffer: 4096,
    });
  } catch {
    throw new Error('Не удалось снять дамп PostgreSQL; проверь логи приложения и доступность БД');
  }
  const envFile = env.BACKUP_ENV_FILE || join(process.cwd(), '.env');
  if (!(await stat(envFile).catch(() => null))?.isFile()) {
    throw new Error('Файл .env недоступен для полного бэкапа');
  }
  await copyFile(envFile, join(work, '.env'));
  const secretsDir = env.BACKUP_SECRETS_DIR || join(process.cwd(), 'secrets');
  const files = await readdir(secretsDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  for (const file of files) {
    const source = join(secretsDir, file);
    if (!(await lstat(source)).isFile()) continue;
    await mkdir(join(work, 'secrets'), { mode: 0o700 });
    await copyFile(source, join(work, 'secrets', file));
  }
  await writeFile(join(work, 'MANIFEST.txt'),
    `basketballgod backup\ncreated: ${new Date().toISOString()}\nhost: ${process.env.HOSTNAME || 'unknown'}\n`,
    { mode: 0o600 });
}

let running = false;

export async function runBackup(): Promise<string> {
  if (running) throw new Error('Резервное копирование уже выполняется');
  running = true;
  const client = await pool.connect().catch((err) => { running = false; throw err; });
  let locked = false;
  let work = '';
  let partial = '';
  try {
    const lock = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [LOCK_ID]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new Error('Резервное копирование уже выполняется');
    const config = await getBackupConfig();
    const { local } = await prepareBackupDirectory(config.subdir);
    work = await mkdtemp(join(tmpdir(), 'bbg-backup-'));
    await chmod(work, 0o700);
    await createBackupFiles(work);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/^(.{4})(.{2})(.{2})T(.{2})(.{2})(.{2})(.{3})Z$/, '$1-$2-$3_$4$5$6$7');
    const name = `basketballgod_${stamp}.tar.gz`;
    partial = join(local, `.${name}.${process.pid}.partial`);
    await execFile('tar', ['-czf', partial, '-C', work, '.'], { timeout: 30 * 60_000, maxBuffer: 4096 });
    await chmod(partial, 0o600);
    await rename(partial, join(local, name));
    partial = '';
    const archives = await listBackupArchives(config.subdir);
    for (const old of archives.slice(config.keep_count)) await rm(join(local, old.name));
    await recordBackupResult(null);
    return name;
  } catch (err) {
    const message = (err as Error).message;
    await recordBackupResult(message).catch(() => undefined);
    throw err;
  } finally {
    if (partial) await rm(partial, { force: true }).catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
    if (locked) await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
    running = false;
  }
}
