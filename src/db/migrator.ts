import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { log } from '../util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

/**
 * Forward-only мигратор: применяет ещё не выполненные *.sql по порядку имён,
 * каждую в своей транзакции. Идемпотентен — безопасно вызывать на старте.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await pool.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(name) values ($1)', [file]);
      await client.query('commit');
      log.info(`[migrate] применена ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Миграция ${file} упала: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  await pool.query('insert into tariffs (id) values (1) on conflict (id) do nothing');
}
