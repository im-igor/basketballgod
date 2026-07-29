import { readPlayersSheet } from '../google/sheets.js';
import { listPlayers, upsertPlayer, setActive } from '../db/repos/players.repo.js';
import { reconcileActivityDates } from '../domain/activity.js';
import { log } from '../util/logger.js';

/**
 * Импорт игроков из Google-таблицы (источник правды) в Postgres.
 *
 * - присутствующие в листе строки — upsert (лист полностью авторитетен, включая active*);
 * - игроки, которые есть в БД, но удалены из листа, — деактивируются (active=false),
 *   строка и история (взносы/голоса) сохраняются.
 *
 * Пул соединений НЕ закрывается — функция вызывается из работающего приложения
 * (cron / команда бота / админ-панель). Для разового CLI-импорта см.
 * scripts/import-players.ts.
 */
export async function importPlayersFromSheet(): Promise<{ imported: number; deactivated: number }> {
  const sheetPlayers = await readPlayersSheet();

  let imported = 0;
  for (const p of sheetPlayers) {
    // Согласуем даты: устаревший active_to (раньше active_from) не тащим в БД.
    const { active_from, active_to } = reconcileActivityDates(p.active_from, p.active_to);
    await upsertPlayer({
      name: p.name,
      tg_login: p.tg_login,
      team: p.team,
      is_employee: p.is_employee,
      active: p.active,
      active_from,
      active_to,
      notes: p.notes,
    });
    imported++;
  }

  // Реконсиляция удалённых: кто есть в БД и активен, но отсутствует в листе.
  const inSheet = new Set(sheetPlayers.map((p) => p.tg_login.toLowerCase()));
  const dbPlayers = await listPlayers();
  let deactivated = 0;
  for (const p of dbPlayers) {
    if (p.active && !inSheet.has(p.tg_login.toLowerCase())) {
      await setActive(p.tg_login, false, null, null);
      deactivated++;
    }
  }

  log.info(`[players-import] импортировано ${imported}, деактивировано ${deactivated}`);
  return { imported, deactivated };
}
