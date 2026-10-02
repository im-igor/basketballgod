import cron from 'node-cron';
import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import { buildAndSaveBudgets } from '../services/budget.service.js';
import { sendBudgetDraftToAdmins, sendMonthlyPayoutToAdmins } from '../services/notify.service.js';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
import type { CronConfig } from '../db/types.js';
import { nextMonthOf, monthLabel } from '../domain/dates.js';
import { log } from '../util/logger.js';
import { refreshConfiguredSchedules } from '../services/scheduleRefresh.service.js';
import { calculateAndSaveMonthlyPayout } from '../services/monthlyPayout.service.js';
import { markMonthlyPayoutNotified } from '../db/repos/monthlyPayouts.repo.js';

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
  pollTrainingCron: string;
  pollGameCron: string;
  budgetCron: string;
  scheduleImportCron: string | null;
}

/** «ЧЧ:ММ» → {h, m}, иначе null. */
function parseHm(time: string | null | undefined): { h: number; m: number } | null {
  const m = (time ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** День недели 1=Пн…7=Вс → формат cron (0=Вс…6=Сб), иначе null. */
function toCronDow(wd: number | null | undefined): number | null {
  if (wd == null || !Number.isInteger(wd) || wd < 1 || wd > 7) return null;
  return wd === 7 ? 0 : wd;
}

const RECONCILE_CRON = '*/5 * * * *'; // правки cron_config подхватываются не позднее чем через 5 минут
const MONTH_END_PAYOUT_CRON = '55 23 28-31 * *';
const MONTH_END_PAYOUT_RETRY_CRON = '5 0 1 * *';

/** Проверка последнего календарного дня в таймзоне планировщика. */
export function isLastDayOfMonthInTimeZone(now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthInTimeZone(now: Date, timeZone: string): { month: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  const read = (type: 'year' | 'month') => Number(parts.find((p) => p.type === type)?.value);
  return { month: read('month'), year: read('year') };
}

function previousMonth(period: { month: number; year: number }): { month: number; year: number } {
  return period.month === 1
    ? { month: 12, year: period.year - 1 }
    : { month: period.month - 1, year: period.year };
}

async function finalizeMonthlyPayout(api: Api, month: number, year: number): Promise<void> {
  const payout = await calculateAndSaveMonthlyPayout(month, year);
  if (payout.notified_at) return;
  await sendMonthlyPayoutToAdmins(api, payout);
  await markMonthlyPayoutNotified(month, year);
}

/** Поддерживаемые человеком интервалы → стабильное cron-выражение. */
export function scheduleImportCron(intervalMinutes: number): string {
  if (intervalMinutes === 15 || intervalMinutes === 30) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes === 60) return '0 * * * *';
  if ([120, 240, 360, 720].includes(intervalMinutes)) return `0 */${intervalMinutes / 60} * * *`;
  if (intervalMinutes === 1440) return '0 3 * * *';
  throw new Error(`Неподдерживаемый интервал проверки расписаний: ${intervalMinutes}`);
}

/** Расписание из env/дефолтов — фолбэк, когда таблица недоступна или поля не заданы. */
function envSchedule(): Schedule {
  return {
    tz: env.TZ,
    pollTrainingCron: env.POLL_TRAINING_CRON,
    pollGameCron: env.POLL_GAME_CRON,
    budgetCron: env.MONTHLY_CRON,
    scheduleImportCron: null,
  };
}

/** «день недели + время» → cron-выражение, иначе фолбэк. */
export function weeklyCron(
  time: string | null | undefined,
  weekday: number | null | undefined,
  fallback: string,
): string {
  const t = parseHm(time);
  const dow = toCronDow(weekday);
  return t && dow !== null ? `${t.m} ${t.h} * * ${dow}` : fallback;
}

/** Собрать расписание из значений cron_config; каждое поле — с фолбэком на env/дефолты. */
function buildSchedule(cfg: CronConfig): Schedule {
  const fb = envSchedule();
  const budT = parseHm(cfg.budget_time);
  const dayOk = (d: number | null | undefined): d is number => d != null && d >= 1 && d <= 28;
  return {
    tz: cfg.timezone || fb.tz,
    pollTrainingCron: weeklyCron(cfg.poll_training_time, cfg.poll_training_weekday, fb.pollTrainingCron),
    pollGameCron: weeklyCron(cfg.poll_game_time, cfg.poll_game_weekday, fb.pollGameCron),
    budgetCron: budT && dayOk(cfg.budget_day) ? `${budT.m} ${budT.h} ${cfg.budget_day} * *` : fb.budgetCron,
    scheduleImportCron: cfg.schedule_import_enabled
      ? scheduleImportCron(cfg.schedule_import_interval_minutes || 60)
      : null,
  };
}

/**
 * Прочитать расписание из cron_config (БД). fromDb=false, если БД прочитать не удалось —
 * тогда при реконсиляции НЕ трогаем текущее расписание (защита от «тряски» при сбоях).
 */
async function loadSchedule(): Promise<{ sch: Schedule; fromDb: boolean }> {
  try {
    const cfg = await getCronConfig();
    return { sch: buildSchedule(cfg), fromDb: true };
  } catch (err) {
    log.warn('[cron] cron_config недоступен — расписание из env/дефолтов', (err as Error).message);
    return { sch: envSchedule(), fromDb: false };
  }
}

function scheduleKey(s: Schedule): string {
  return `${s.tz}|${s.pollTrainingCron}|${s.pollGameCron}|${s.budgetCron}|${s.scheduleImportCron ?? 'off'}`;
}

// Активные задачи расписания (пересоздаются при смене конфига) и «ключ» текущего расписания.
let tasks: ReturnType<typeof cron.schedule>[] = [];
let currentKey = '';
let schedulerApi: Api | null = null;

/** Остановить старые задачи и запланировать заново по данному расписанию. */
function applySchedule(api: Api, sch: Schedule): void {
  for (const expr of [
    sch.pollTrainingCron,
    sch.pollGameCron,
    sch.budgetCron,
    sch.scheduleImportCron,
    MONTH_END_PAYOUT_CRON,
    MONTH_END_PAYOUT_RETRY_CRON,
  ].filter((x): x is string => x !== null)) {
    if (!cron.validate(expr)) {
      log.error(`[cron] некорректное выражение "${expr}" — расписание не изменено`);
      return;
    }
  }

  for (const t of tasks) t.stop();
  tasks = [
    // Опросы на тренировки (TYPE=TRAINING, с форвардом в чат другой команды).
    cron.schedule(sch.pollTrainingCron, job('weekly-polls-training', async () => {
      await sendWeeklyPolls(api, 'training');
    }), { timezone: sch.tz }),

    // Опросы на игры (TYPE=GAME|FRIENDLY, без форварда).
    cron.schedule(sch.pollGameCron, job('weekly-polls-game', async () => {
      await sendWeeklyPolls(api, 'game', { trackWindow: true });
    }), { timezone: sch.tz }),

    // Бюджет: собираем бюджеты обеих команд по составу и тарифам из БД,
    // отправляем ЧЕРНОВИКИ администраторам в личку (в чаты публикует админ кнопкой).
    cron.schedule(sch.budgetCron, job('monthly-budget', async () => {
      const { month, year } = nextMonthOf(new Date());
      log.info(`[cron] сбор бюджета за ${monthLabel(month, year)}`);
      const built = await buildAndSaveBudgets(month, year);
      await sendBudgetDraftToAdmins(api, built);
    }), { timezone: sch.tz }),

    // В 23:55 последнего календарного дня фиксируем реальные тренировки, игры и
    // аренды месяца. Снимок сохраняется в БД и один раз уходит администраторам.
    cron.schedule(MONTH_END_PAYOUT_CRON, job('monthly-payout', async () => {
      const now = new Date();
      if (!isLastDayOfMonthInTimeZone(now, sch.tz)) return;
      const { month, year } = monthInTimeZone(now, sch.tz);
      await finalizeMonthlyPayout(api, month, year);
    }), { timezone: sch.tz }),

    // Страховка на случай недоступности приложения или Telegram в 23:55.
    // Сохранённый и уже отправленный снимок повторно не рассылается.
    cron.schedule(MONTH_END_PAYOUT_RETRY_CRON, job('monthly-payout-retry', async () => {
      const period = previousMonth(monthInTimeZone(new Date(), sch.tz));
      await finalizeMonthlyPayout(api, period.month, period.year);
    }), { timezone: sch.tz }),
  ];
  if (sch.scheduleImportCron) {
    tasks.push(cron.schedule(sch.scheduleImportCron, job('schedule-import', async () => {
      const results = await refreshConfiguredSchedules(api);
      for (const result of results) {
        const summary = `${result.source}/${result.team}: найдено ${result.found}, новых ${result.newGames}, ` +
          `Calendar ${result.calendarSynced}, голосовалок ${result.pollsSent}, ожидают окна ${result.pollsDeferred}`;
        const errors = [...result.errors, ...result.pollErrors];
        if (result.ok && errors.length === 0) log.info(`[schedule-import] ${summary}`);
        else log.warn(`[schedule-import] ${summary}; ${errors.join('; ')}`);
      }
    }), { timezone: sch.tz }));
  }
  currentKey = scheduleKey(sch);
  log.info(
    `[cron] расписание активно (TZ=${sch.tz}) — опросы: тренировки "${sch.pollTrainingCron}", ` +
      `игры "${sch.pollGameCron}"; бюджет "${sch.budgetCron}"; ` +
      `расчёты в конце месяца "${MONTH_END_PAYOUT_CRON}" (проверка "${MONTH_END_PAYOUT_RETRY_CRON}"); ` +
      `импорт расписаний ${sch.scheduleImportCron ? `"${sch.scheduleImportCron}"` : 'выключен'}`,
  );
}

export async function startScheduler(api: Api): Promise<void> {
  schedulerApi = api;
  const { sch } = await loadSchedule();
  applySchedule(api, sch);

  // Горячая перечитка: периодически сверяем расписание с БД и переприменяем при изменении.
  // Так правки cron_config (через админку/синк) подхватываются без перезапуска бота.
  cron.schedule(RECONCILE_CRON, () => {
    void reloadScheduler()
      .catch((err) => log.warn('[cron] реконсиляция расписания не удалась', (err as Error).message));
  }, { timezone: env.TZ });

  log.info(`[cron] горячая перечитка расписания включена ("${RECONCILE_CRON}")`);
}

/** Немедленно применить изменённый cron_config. До запуска планировщика — безопасный no-op. */
export async function reloadScheduler(): Promise<boolean> {
  if (!schedulerApi) return false;
  const { sch: next, fromDb } = await loadSchedule();
  if (!fromDb || scheduleKey(next) === currentKey) return false;
  log.info('[cron] расписание изменилось в БД — переприменяю');
  applySchedule(schedulerApi, next);
  return true;
}
