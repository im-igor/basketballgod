import { migrate } from './migrator.js';
import { closePool } from './pool.js';

/** CLI-обёртка: npm run migrate */
migrate()
  .then(() => console.log('✅ Миграции применены'))
  .catch((err) => {
    console.error('❌', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
