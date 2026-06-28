import { env } from '../config/env.js';
import { sheetsClient } from '../google/auth.js';
import { upsertPlayer } from '../db/repos/players.repo.js';
import { closePool } from '../db/pool.js';
import type { Team } from '../db/types.js';

/**
 * Разовый импорт игроков из Google Sheet (вкладка Players) в Postgres.
 * Колонки: № | name | tg_login | employee | team | active | active_from | active_to | notes
 *
 * Запуск (dev):  npm run import:players
 * Запуск (prod): node dist/scripts/import-players.js
 */

function ruDateToISO(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
}

async function main(): Promise<void> {
  if (!env.GOOGLE_SHEET_ID) throw new Error('Задай GOOGLE_SHEET_ID в .env');

  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: 'Players!A:I',
  });
  const rows = res.data.values ?? [];
  if (rows.length <= 1) {
    console.log('Нет данных для импорта.');
    return;
  }

  let imported = 0;
  // Пропускаем строку заголовка.
  for (const row of rows.slice(1)) {
    const [, name, tgLogin, employee, team, active, activeFrom, activeTo, notes] = row as string[];
    if (!name || !tgLogin || (team !== 'RED' && team !== 'BLACK')) continue;

    const login = tgLogin.startsWith('@') ? tgLogin : `@${tgLogin}`;
    const isActive = (active ?? '').trim().toUpperCase() === 'YES';

    await upsertPlayer({
      name: name.trim(),
      tg_login: login.trim(),
      team: team as Team,
      is_employee: (employee ?? '').trim().toUpperCase() === 'TRUE',
      active: isActive,
      active_from: ruDateToISO(activeFrom),
      active_to: ruDateToISO(activeTo),
      notes: notes?.trim() || null,
    });
    imported++;
  }

  console.log(`✅ Импортировано игроков: ${imported}`);
}

main()
  .catch((err) => {
    console.error('❌', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
