import { importPlayersFromSheet } from '../services/playersImport.service.js';
import { closePool } from '../db/pool.js';

/**
 * Разовый CLI-импорт игроков из Google Sheet (вкладка Players) в Postgres.
 * Используется для первичного засева/восстановления. Логика — в
 * services/playersImport.service.ts (та же, что у /sync_players и кнопки в админке).
 *
 * Запуск (dev):  npm run import:players
 * Запуск (prod): node dist/scripts/import-players.js
 */
async function main(): Promise<void> {
  const { imported, deactivated } = await importPlayersFromSheet();
  console.log(`✅ Импортировано игроков: ${imported}, деактивировано: ${deactivated}`);
}

main()
  .catch((err) => {
    console.error('❌', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
