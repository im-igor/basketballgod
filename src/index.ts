import { env } from './config/env.js';
import { migrate } from './db/migrator.js';
import { closePool } from './db/pool.js';
import { bot, setupBotCommandsMenu } from './bot/bot.js';
import { buildServer } from './http/server.js';
import { startScheduler } from './scheduler/cron.js';
import { log } from './util/logger.js';

async function main(): Promise<void> {
  log.info('🏀 basketballgod запускается…');

  // 1. Миграции БД (идемпотентно).
  await migrate();
  log.info('[db] миграции готовы');

  // 2. HTTP-сервер: healthcheck, админ-панель, (опц.) Telegram webhook.
  const app = await buildServer(bot);
  await app.listen({ host: '0.0.0.0', port: env.HTTP_PORT });
  log.info(`[http] слушаю на :${env.HTTP_PORT} (админ-панель / healthz)`);

  // 3. Telegram-бот: webhook или long polling.
  await setupBotCommandsMenu().catch((e) => log.warn('[bot] меню команд', (e as Error).message));
  if (env.TELEGRAM_USE_WEBHOOK && env.WEBHOOK_DOMAIN && env.WEBHOOK_SECRET) {
    await bot.init();
    const url = `${env.WEBHOOK_DOMAIN}/webhook/${env.WEBHOOK_SECRET}`;
    await bot.api.setWebhook(url, { secret_token: env.WEBHOOK_SECRET, drop_pending_updates: true });
    log.info(`[bot] webhook установлен: ${url}`);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => undefined);
    void bot.start({ onStart: () => log.info('[bot] long polling запущен') });
  }

  // 4. Планировщик (расписание читается из вкладки `cron` Google-таблицы с фолбэком на env).
  await startScheduler(bot.api);

  // 5. Корректное завершение.
  const shutdown = async (sig: string) => {
    log.info(`[app] получен ${sig}, останавливаюсь…`);
    try {
      await bot.stop().catch(() => undefined);
      await app.close().catch(() => undefined);
      await closePool().catch(() => undefined);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('✅ basketballgod готов к работе');
}

main().catch((err) => {
  log.error('Фатальная ошибка запуска:', (err as Error).message);
  process.exit(1);
});
