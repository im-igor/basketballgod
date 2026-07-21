import {
  readPlayersSheet,
  writePlayersSheet,
  readCronConfigFromSheet,
  writeCronToSheet,
  writeTariffsToSheet,
  readTagsFromSheet,
  writeTagsToSheet,
  type SheetPlayer,
} from '../google/sheets.js';
import { importPlayersFromSheet } from './playersImport.service.js';
import { importTariffsFromSheet } from './tariffsImport.service.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { getCronConfig, updateCronConfig } from '../db/repos/cronConfig.repo.js';
import { listTags, replaceAllTags } from '../db/repos/tags.repo.js';
import { log } from '../util/logger.js';

/**
 * Двусторонняя синхронизация конфигурационных вкладок Google-таблицы и БД.
 *
 * БД — источник правды для приложения, таблица — бэкап/обмен.
 * `import…FromSheet` — таблица → БД; `export…ToSheet` — БД → таблица.
 * Разделы: Players, Tariffs (`tariffs`), Cron (`cron`), Tags (`Tags`).
 */

// ── Cron ────────────────────────────────────────────────────────────────
export async function importCronFromSheet(): Promise<string> {
  const cfg = await readCronConfigFromSheet();
  await updateCronConfig({
    timezone: cfg.timezone ?? undefined,
    poll_weekday: cfg.poll_weekday ?? undefined,
    poll_time: cfg.poll_time ?? undefined,
    fixation_day: cfg.fixation_day ?? undefined,
    fixation_time: cfg.fixation_time ?? undefined,
    budget_day: cfg.budget_day ?? undefined,
    budget_time: cfg.budget_time ?? undefined,
  });
  return 'Крон: загружен из таблицы';
}

export async function exportCronToSheet(): Promise<string> {
  const c = await getCronConfig();
  await writeCronToSheet(c);
  return 'Крон: выгружен в таблицу';
}

// ── Tariffs ─────────────────────────────────────────────────────────────
export async function importTariffsToDb(): Promise<string> {
  await importTariffsFromSheet();
  return 'Тарифы: загружены из таблицы';
}

export async function exportTariffsToSheet(): Promise<string> {
  const t = await getTariffs();
  await writeTariffsToSheet(t);
  return 'Тарифы: выгружены в таблицу';
}

// ── Players ─────────────────────────────────────────────────────────────
export async function importPlayersToDb(): Promise<string> {
  const { imported, deactivated } = await importPlayersFromSheet();
  return `Игроки: загружено ${imported}, деактивировано ${deactivated}`;
}

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
export async function importTagsToDb(): Promise<string> {
  const rows = await readTagsFromSheet();
  const n = await replaceAllTags(
    rows.map((t, i) => ({
      tag_key: t.tag_key,
      tag_value: t.tag_value,
      description: t.description,
      sort_order: (i + 1) * 10,
    })),
  );
  return `Теги: загружено ${n}`;
}

export async function exportTagsToSheet(): Promise<string> {
  const tags = await listTags();
  await writeTagsToSheet(
    tags.map((t) => ({ tag_key: t.tag_key, tag_value: t.tag_value, description: t.description })),
  );
  return `Теги: выгружено ${tags.length}`;
}

// ── Агрегаты (все вкладки разом) ──────────────────────────────────────────

/** Прогнать список шагов, собрав сводку; ошибку по шагу логируем и продолжаем. */
async function runAll(steps: Array<() => Promise<string>>): Promise<string> {
  const report: string[] = [];
  for (const step of steps) {
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

/** Все вкладки: таблица → БД. */
export async function syncAllFromSheet(): Promise<string> {
  return runAll([importPlayersToDb, importTariffsToDb, importCronFromSheet, importTagsToDb]);
}

/** Все вкладки: БД → таблица. */
export async function syncAllToSheet(): Promise<string> {
  return runAll([exportPlayersToSheet, exportTariffsToSheet, exportCronToSheet, exportTagsToSheet]);
}
