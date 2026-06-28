import cron from 'node-cron';
import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import { buildAndSaveBudgets } from '../services/budget.service.js';
import { sendBudgetDraftToAdmins } from '../services/notify.service.js';
import { importPlayersFromSheet } from '../services/playersImport.service.js';
import { nextMonthOf, monthLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';

/** Обёртка задачи: ошибки не должны ронять процесс. */
function job(name: string, fn: () => Promise<void>): () => void {
  return () => {
    log.info(`[cron] старт: ${name}`);
    fn()
      .then(() => log.info(`[cron] готово: ${name}`))
      .catch((err) => log.error(`[cron] ошибка: ${name}`, (err as Error).message));
  };
}

export function startScheduler(api: Api): void {
  if (!cron.validate(env.POLL_CRON)) throw new Error(`Некорректный POLL_CRON: ${env.POLL_CRON}`);
  if (!cron.validate(env.MONTHLY_CRON)) throw new Error(`Некорректный MONTHLY_CRON: ${env.MONTHLY_CRON}`);

  // Рассылка опросов (по умолчанию пятница 12:00)
  cron.schedule(env.POLL_CRON, job('weekly-polls', async () => {
    await sendWeeklyPolls(api);
  }), { timezone: env.TZ });

  // Бюджет на следующий месяц (по умолчанию 25-е число 10:00):
  // сначала импортируем актуальный состав из таблицы, затем собираем бюджет и
  // отправляем ЧЕРНОВИКИ администраторам в личку (в чаты публикует админ кнопкой).
  cron.schedule(env.MONTHLY_CRON, job('monthly-budget', async () => {
    const { month, year } = nextMonthOf(new Date());
    log.info(`[cron] импорт игроков из таблицы и сбор бюджета за ${monthLabel(month, year)}`);
    await importPlayersFromSheet();
    const built = await buildAndSaveBudgets(month, year);
    await sendBudgetDraftToAdmins(api, built);
  }), { timezone: env.TZ });

  log.info(
    `[cron] расписание активно (TZ=${env.TZ}) — опросы "${env.POLL_CRON}", бюджет "${env.MONTHLY_CRON}"`,
  );
}
