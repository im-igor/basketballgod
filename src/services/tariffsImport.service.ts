import { readTariffsFromSheet } from '../google/sheets.js';
import { updateTariffs } from '../db/repos/tariffs.repo.js';
import { log } from '../util/logger.js';

/**
 * Синхронизировать тарифы из вкладки `tariffs` Google-таблицы в БД (источник правды — таблица).
 * Вызывается перед расчётом бюджета (крон и команда /budget), чтобы суммы всегда были свежими.
 * Резильентно: если вкладка недоступна или значения битые — оставляем текущие в БД
 * (updateTariffs игнорирует undefined через coalesce), чтобы не ронять сборку бюджета.
 */
export async function importTariffsFromSheet(): Promise<void> {
  let t;
  try {
    t = await readTariffsFromSheet();
  } catch (err) {
    log.warn(
      '[tariffs-import] не удалось прочитать вкладку tariffs — используем текущие тарифы из БД',
      (err as Error).message,
    );
    return;
  }

  await updateTariffs({
    gym_paid_price: t.gym_paid_price,
    locker_rent_price: t.locker_rent_price,
    coach_per_session: t.coach_per_session,
    coach_per_game: t.coach_per_game,
    referee_default: t.referee_default,
  });

  log.info(
    `[tariffs-import] из таблицы: gym=${t.gym_paid_price ?? '—'}, locker=${t.locker_rent_price ?? '—'}, ` +
      `coach_session=${t.coach_per_session ?? '—'}, coach_game=${t.coach_per_game ?? '—'}, ` +
      `referee=${t.referee_default ?? '—'}`,
  );
}
