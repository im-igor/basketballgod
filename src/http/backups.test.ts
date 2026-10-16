import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import type { Bot } from 'grammy';

test('архивы видны и скачиваются только после входа в админку', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bbg-backup-http-'));
  const root = join(temp, 'backups');
  process.env.BACKUP_HOST_ROOT = root;
  process.env.BACKUP_MOUNT_ROOT = root;
  const [{ pool }, { migrate }, { buildServer }] = await Promise.all([
    import('../db/pool.js'), import('../db/migrator.js'), import('./server.js'),
  ]);
  const db = new PGlite();
  const sql = (text: string, params?: unknown[]) => params ? db.query(text, params) : db.exec(text).then((results) => results.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({
    query: sql,
    release: () => undefined,
  }));
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await migrate();
    await mkdir(root);
    const name = 'basketballgod_2026-10-16_041200123.tar.gz';
    await writeFile(join(root, name), 'archive');
    app = await buildServer({ api: {} } as Bot);
    const denied = await app.inject({ method: 'GET', url: `/backups/download/${name}` });
    assert.equal(denied.statusCode, 302);
    assert.equal(denied.headers.location, '/login');
    const login = await app.inject({ method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=test&password=test-password' });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    const page = await app.inject({ method: 'GET', url: '/backups', headers: { cookie } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Резервные копии/);
    assert.match(page.body, /Полное восстановление на новой ВМ/);
    assert.match(page.body, /basketballgod_2026-10-16_041200123.tar.gz/);
    const settings = await app.inject({ method: 'POST', url: '/backups/settings',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ frequency: 'daily', weekday: '1', month_day: '1',
        run_time: '03:30', host_path: join(root, 'daily'), keep_count: '3' }).toString() });
    assert.equal(settings.statusCode, 302);
    const saved = await db.query<{ subdir: string; frequency: string }>('select subdir, frequency from backup_config where id=1');
    assert.deepEqual(saved.rows[0], { subdir: 'daily', frequency: 'daily' });
    const rejected = await app.inject({ method: 'POST', url: '/backups/settings',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ frequency: 'daily', weekday: '1', month_day: '1',
        run_time: '03:30', host_path: temp, keep_count: '3' }).toString() });
    assert.equal(rejected.statusCode, 302);
    assert.equal((await db.query<{ subdir: string }>('select subdir from backup_config where id=1')).rows[0]?.subdir, 'daily');
    await db.query("update backup_config set subdir='' where id=1");
    const download = await app.inject({ method: 'GET', url: `/backups/download/${name}`, headers: { cookie } });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, 'archive');
    assert.match(String(download.headers['content-disposition']), /attachment/);
    const invalid = await app.inject({ method: 'GET', url: '/backups/download/not-a-backup.tar.gz', headers: { cookie } });
    assert.equal(invalid.statusCode, 404);
  } finally {
    await app?.close();
    mock.restoreAll();
    await db.close();
    await pool.end();
    await rm(temp, { recursive: true, force: true });
  }
});
