import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('путь резервных копий ограничен смонтированным корнем, а скачивание — именем архива', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bbg-backup-test-'));
  const root = join(temp, 'backups');
  process.env.BACKUP_HOST_ROOT = root;
  process.env.BACKUP_MOUNT_ROOT = root;
  const { backupPaths, prepareBackupDirectory, listBackupArchives, openBackupArchive } = await import('./backup.service.js');
  try {
    await mkdir(root);
    assert.equal(backupPaths(join(root, 'weekly')).local, join(root, 'weekly'));
    assert.equal(backupPaths('weekly').host, join(root, 'weekly'));
    assert.throws(() => backupPaths(join(temp, 'outside')), /внутри/);
    assert.throws(() => backupPaths(`${root}/../outside`), /нормализованный/);
    await symlink(temp, join(root, 'link'));
    await assert.rejects(prepareBackupDirectory(join(root, 'link', 'escape')), /Символические ссылки/);
    await prepareBackupDirectory(join(root, 'weekly'));
    const archive = 'basketballgod_2026-10-16_041200123.tar.gz';
    await writeFile(join(root, 'weekly', archive), 'archive');
    await writeFile(join(root, 'weekly', 'not-a-backup.tar.gz'), 'ignore');
    assert.deepEqual((await listBackupArchives(join(root, 'weekly'))).map((a) => a.name), [archive]);
    assert.equal(await openBackupArchive(join(root, 'weekly'), '../.env'), null);
    const opened = await openBackupArchive(join(root, 'weekly'), archive);
    assert.equal(opened?.size, 7);
    opened?.stream.destroy();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('pg_dump получает адрес БД и учётные данные отдельными переменными, а ошибка маскирует секреты', async () => {
  const { pgDumpConnectionEnv, backupErrorMessage } = await import('./backup.service.js');
  const connection = 'postgresql://backup:p%40ssword@db:5433/basketballgod?sslmode=require';
  const pgEnv = pgDumpConnectionEnv(connection);
  assert.equal(pgEnv.PGHOST, 'db');
  assert.equal(pgEnv.PGPORT, '5433');
  assert.equal(pgEnv.PGUSER, 'backup');
  assert.equal(pgEnv.PGPASSWORD, 'p@ssword');
  assert.equal(pgEnv.PGDATABASE, 'basketballgod');
  assert.equal(pgEnv.PGSSLMODE, 'require');
  const message = backupErrorMessage({ stderr: `pg_dump: ${process.env.DATABASE_URL}; password=topsecret` });
  assert.match(message, /pg_dump:/);
  assert.doesNotMatch(message, /unused|topsecret|postgresql:\/\//);
  assert.throws(() => pgDumpConnectionEnv('not-a-url'));
});
