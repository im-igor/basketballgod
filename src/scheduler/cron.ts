import cron from 'node-cron';
import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import { buildAndSaveBudgets } from '../services/budget.service.js';
import { sendBudgetDraftToAdmins, sendBudgetFixationNotice } from '../services/notify.service.js';
import { importPlayersFromSheet } from '../services/playersImport.service.js';
import { importTariffsFromSheet } from '../services/tariffsImport.service.js';
import { readCronConfigFromSheet, type SheetCronConfig } from '../google/sheets.js';
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

interface Schedule {
  tz: string;
  pollCron: string;
  fixationCron: string;
  budgetCron: string;
}

/** «ЧЧ:ММ» → {h, m}, иначе null. */
function parseHm(time: string | undefined): { h: number; m: number } | null {
  const m = (time ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** День недели 1=Пн…7=Вс → формат cron (0=Вс…6=Сб), иначе null. */
function toCronDow(wd: number | undefined): number | null {
  if (wd === undefined || !Number.isInteger(wd) || wd < 1 || wd > 7) return null;
  return wd === 7 ? 0 : wd;
}

const RECONCILE_CRON = '7 * * * *'; // как часто перечитывать вкладку cron (раз в час)

/** Расписание из env/дефолтов — фолбэк, когда таблица недоступна или поля не заданы. */
function envSchedule(): Schedule {
  return {
    tz: env.TZ,
    pollCron: env.POLL_CRON,
    fixationCron: env.MONTHLY_FIXATION_CRON,
    budgetCron: env.MONTHLY_CRON,
  };
}

/** Собрать расписание из значений вкладки `cron`; каждое поле — с фолбэком на env/дефолты. */
function buildSchedule(cfg: SheetCronConfig): Schedule {
  const fb = envSchedule();
  const pollT = parseHm(cfg.poll_time);
  const pollDow = toCronDow(cfg.poll_weekday);
  const fixT = parseHm(cfg.fixation_time);
  const budT = parseHm(cfg.budget_time);
  const dayOk = (d: number | undefined): d is number => d !== undefined && d >= 1 && d <= 28;
  return {
    tz: cfg.timezone || fb.tz,
    pollCron: pollT && pollDow !== null ? `${pollT.m} ${pollT.h} * * ${pollDow}` : fb.pollCron,
    fixationCron: fixT && dayOk(cfg.fixation_day) ? `${fixT.m} ${fixT.h} ${cfg.fixation_day} * *` : fb.fixationCron,
    budgetCron: budT && dayOk(cfg.budget_day) ? `${budT.m} ${budT.h} ${cfg.budget_day} * *` : fb.budgetCron,
  };
}

/**
 * Прочитать расписание из вкладки `cron`. fromSheet=false, если таблицу прочитать не удалось —
 * тогда при реконсиляции НЕ трогаем текущее расписание (защита от «тряски» при сбоях сети).
 */
async function loadSchedule(): Promise<{ sch: Schedule; fromSheet: boolean }> {
  try {
    const cfg = await readCronConfigFromSheet();
    return { sch: buildSchedule(cfg), fromSheet: true };
  } catch (err) {
    log.warn('[cron] вкладка cron недоступна — расписание из env/дефолтов', (err as Error).message);
    return { sch: envSchedule(), fromSheet: false };
  }
}

function scheduleKey(s: Schedule): string {
  return `${s.tz}|${s.pollCron}|${s.fixationCron}|${s.budgetCron}`;
}

// Активные задачи расписания (пересоздаются при смене конфига) и «ключ» текущего расписания.
let tasks: ReturnType<typeof cron.schedule>[] = [];
let currentKey = '';

/** Остановить старые задачи и запланировать заново по данному расписанию. */
function applySchedule(api: Api, sch: Schedule): void {
  for (const expr of [sch.pollCron, sch.fixationCron, sch.budgetCron]) {
    if (!cron.validate(expr)) {
      log.error(`[cron] некорректное выражение "${expr}" — расписание не изменено`);
      return;
    }
  }

  for (const t of tasks) t.stop();
  tasks = [
    // Рассылка опросов (по умолчанию пятница 12:00).
    cron.schedule(sch.pollCron, job('weekly-polls', async () => {
      await sendWeeklyPolls(api);
    }), { timezone: sch.tz }),

    // Уведомление о фиксации участников: за сутки до сбора шлём в чаты обеих команд.
    cron.schedule(sch.fixationCron, job('budget-fixation-notice', async () => {
      await sendBudgetFixationNotice(api);
    }), { timezone: sch.tz }),

    // Бюджет: импортируем игроков и тарифы из таблицы, собираем бюджеты обеих команд,
    // отправляем ЧЕРНОВИКИ администраторам в личку (в чаты публикует админ кнопкой).
    cron.schedule(sch.budgetCron, job('monthly-budget', async () => {
      const { month, year } = nextMonthOf(new Date());
      log.info(`[cron] импорт игроков и тарифов из таблицы, сбор бюджета за ${monthLabel(month, year)}`);
      await importPlayersFromSheet();
      await importTariffsFromSheet();
      const built = await buildAndSaveBudgets(month, year);
      await sendBudgetDraftToAdmins(api, built);
    }), { timezone: sch.tz }),
  ];
  currentKey = scheduleKey(sch);
  log.info(
    `[cron] расписание активно (TZ=${sch.tz}) — опросы "${sch.pollCron}", ` +
      `фиксация "${sch.fixationCron}", бюджет "${sch.budgetCron}"`,
  );
}

export async function startScheduler(api: Api): Promise<void> {
  const { sch } = await loadSchedule();
  applySchedule(api, sch);

  // Горячая перечитка: периодически сверяем расписание с таблицей и переприменяем при изменении.
  // Так правки в вкладке `cron` подхватываются без перезапуска бота (в пределах интервала).
  cron.schedule(RECONCILE_CRON, () => {
    void loadSchedule()
      .then(({ sch: next, fromSheet }) => {
        if (!fromSheet) return; // не смогли прочитать — оставляем текущее
        if (scheduleKey(next) === currentKey) return; // без изменений
        log.info('[cron] расписание изменилось в таблице — переприменяю');
        applySchedule(api, next);
      })
      .catch((err) => log.warn('[cron] реконсиляция расписания не удалась', (err as Error).message));
  }, { timezone: env.TZ });

  log.info(`[cron] горячая перечитка расписания включена ("${RECONCILE_CRON}")`);
}
