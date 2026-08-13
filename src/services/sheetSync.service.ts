import {
  writePlayersSheet,
  writeCronToSheet,
  writeTariffsToSheet,
  writeTagsToSheet,
  type SheetPlayer,
} from '../google/sheets.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
import { listTags } from '../db/repos/tags.repo.js';
import { log } from '../util/logger.js';

/**
 * Односторонняя выгрузка БД → Google-таблица (витрина «показать человеку»).
 *
 * БД — единственный источник правды; обратной загрузки нет, и таблица на данные
 * приложения никак не влияет. Разделы: Players, Tariffs (`tariffs`),
 * Cron (`cron`), Tags (`Tags`).
 */

// ── Cron ────────────────────────────────────────────────────────────────
export async function exportCronToSheet(): Promise<string> {
  const c = await getCronConfig();
  await writeCronToSheet(c);
  return 'Крон: выгружен в таблицу';
}

// ── Tariffs ─────────────────────────────────────────────────────────────
export async function exportTariffsToSheet(): Promise<string> {
  const t = await getTariffs();
  await writeTariffsToSheet(t);
  return 'Тарифы: выгружены в таблицу';
}

// ── Players ─────────────────────────────────────────────────────────────
export async function exportPlayersToSheet(): Promise<string> {
  const players = await listPlayers();
  const sheetPlayers: SheetPlayer[] = players.map((p) => ({
    name: p.name,
    tg_login: p.tg_login,
    is_employee: p.is_employee,
    team: p.team,
    active: p.active,
    active_from: p.active_from,
    active_to: p.active_to,
    notes: p.notes,
  }));
  await writePlayersSheet(sheetPlayers);
  return `Игроки: выгружено ${sheetPlayers.length}`;
}

// ── Tags ────────────────────────────────────────────────────────────────
export async function exportTagsToSheet(): Promise<string> {
  const tags = await listTags();
  await writeTagsToSheet(
    tags.map((t) => ({ tag_key: t.tag_key, tag_value: t.tag_value, description: t.description })),
  );
  return `Теги: выгружено ${tags.length}`;
}

// ── Все вкладки разом ────────────────────────────────────────────────────

/** Все вкладки: БД → таблица. Ошибку по шагу логируем и продолжаем. */
export async function syncAllToSheet(): Promise<string> {
  const report: string[] = [];
  for (const step of [
    exportPlayersToSheet,
    exportTariffsToSheet,
    exportCronToSheet,
    exportTagsToSheet,
  ]) {
    try {
      report.push('✅ ' + (await step()));
    } catch (err) {
      const msg = (err as Error).message;
      log.error('[sheet-sync] шаг упал', msg);
      report.push('⚠️ Ошибка: ' + msg);
    }
  }
  return report.join('\n');
}
