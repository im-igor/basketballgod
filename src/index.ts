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
    // ВАЖНО: bot.catch() ловит только ошибки обработки апдейтов, а НЕ старт polling.
    // Без .catch() отказ getUpdates (напр. 409 Conflict — уже запущен другой инстанс
    // с тем же токеном) остаётся невидимым: процесс жив, админка работает, а бот молчит.
    void bot
      .start({ onStart: (me) => log.info(`[bot] long polling запущен как @${me.username}`) })
      .catch((e) => log.error('[bot] polling НЕ запущен:', (e as Error).message));
  }

  // 4. Планировщик (расписание читается из cron_config в БД с фолбэком на env).
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
