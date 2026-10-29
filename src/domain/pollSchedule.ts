import type { CronConfig, ScheduledGame } from '../db/types.js';
import type { CronJobWindow } from '../db/repos/cronJobWindows.repo.js';
import { calendarHorizonEnd } from './dates.js';

function localParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (key: string) => Number(parts.find((p) => p.type === key)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}
function localInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const desired = Date.UTC(year,month-1,day,hour,minute);
  let candidate = desired;
  for (let i=0;i<4;i++) {
    const p = localParts(new Date(candidate),tz);
    const delta = desired - Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);
    candidate += delta;
    if (!delta) break;
  }
  return new Date(candidate);
}
export function scheduledGameStart(game: ScheduledGame): Date {
  const date = game.game_date instanceof Date ? game.game_date.toISOString().slice(0,10) : String(game.game_date).slice(0,10);
  return new Date(`${date}T${game.game_time ? String(game.game_time).slice(0,5) : '00:00'}:00+03:00`);
}
export function inActivePollWindow(game: ScheduledGame, window: CronJobWindow | null, now: Date): boolean {
  if (!window?.completed_at) return false;
  const started = new Date(window.window_started_at);
  const until = new Date(window.window_until);
  const start = scheduledGameStart(game);
  return now < until && new Date(game.created_at) >= started && start >= started && start < until;
}

/** Следующий реальный cron-такт проверки: привязка к часам, а не now + интервал. */
export function nextScheduleCheck(now: Date, minutes: number, tz: string): Date | null {
  if (![15,30,60,120,240,360,720,1440].includes(minutes)) return null;
  const first = Math.floor(now.getTime()/60000)*60000+60000;
  for (let t=first;t<=first+26*60*60000;t+=60000) {
    const p = localParts(new Date(t),tz);
    const matches = minutes < 60 ? p.minute % minutes === 0
      : minutes === 1440 ? p.hour === 3 && p.minute === 0
      : p.minute === 0 && p.hour % (minutes/60) === 0;
    if (matches) return new Date(t);
  }
  return null;
}

export interface PollScheduleContext {
  now: Date; config: CronConfig; window: CronJobWindow | null; timezone: string;
  weekly: { weekday: number; hour: number; minute: number } | null;
  horizonDays: number; nextCheck: Date | null;
}
export function pollScheduleContext(config: CronConfig, window: CronJobWindow | null, now: Date,
  fallback: { timezone: string; cron: string; horizonDays: number }): PollScheduleContext {
  const timezone = config.timezone || fallback.timezone;
  const [m,h,,,dow] = fallback.cron.trim().split(/\s+/);
  const time = config.poll_game_time?.match(/^(\d{1,2}):(\d{2})$/);
  const configured = config.poll_game_weekday != null && config.poll_game_weekday >= 1 && config.poll_game_weekday <= 7 &&
    time && Number(time[1]) < 24 && Number(time[2]) < 60;
  const weekday = configured ? config.poll_game_weekday! : dow && /^\d$/.test(dow) ? Number(dow) || 7 : NaN;
  const hour = configured ? Number(time[1]) : h && /^\d+$/.test(h) ? Number(h) : NaN;
  const minute = configured ? Number(time[2]) : m && /^\d+$/.test(m) ? Number(m) : NaN;
  const weekly = weekday >= 1 && weekday <= 7 && hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? { weekday, hour, minute } : null;
  return { now,config,window,timezone,weekly,
    horizonDays: config.poll_game_horizon_days && config.poll_game_horizon_days > 0 ? config.poll_game_horizon_days : fallback.horizonDays,
    nextCheck: config.schedule_import_enabled ? nextScheduleCheck(now,config.schedule_import_interval_minutes,timezone) : null };
}
export function scheduledPollStatus(game: ScheduledGame, ctx: PollScheduleContext): { text: string; detail: string; kind: 'yes'|'no'|'black' } {
  if (game.poll_sent_at) return { text:'отправлен',detail:'',kind:'yes' };
  const start = scheduledGameStart(game);
  if (start <= ctx.now) return { text:'не отправлен: игра уже началась',detail:game.poll_last_error ?? '',kind:'no' };
  if (!game.poll_pending) return { text:'не запланирован',detail:game.poll_last_error ?? '',kind:'black' };
  if (!game.calendar_event_id) return { text:'нет связи с календарём',detail:'Сначала требуется синхронизация календаря',kind:'no' };
  const candidates: { at:Date; reason:string }[] = [];
  if (ctx.nextCheck && ctx.config.schedule_import_send_polls &&
      inActivePollWindow(game,ctx.window,ctx.nextCheck) && ctx.nextCheck < start) {
    candidates.push({ at:ctx.nextCheck,reason:`ближайшая проверка расписания · интервал ${ctx.config.schedule_import_interval_minutes} мин.` });
  }
  if (ctx.weekly) {
    const p = localParts(ctx.now,ctx.timezone);
    for (let offset=0;offset<=370;offset++) {
      const day = new Date(Date.UTC(p.year,p.month-1,p.day+offset));
      if ((day.getUTCDay() || 7) !== ctx.weekly.weekday) continue;
      const at = localInstant(day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),ctx.weekly.hour,ctx.weekly.minute,ctx.timezone);
      if (at <= ctx.now) continue;
      if (at >= start) break;
      if (start < calendarHorizonEnd(at,ctx.horizonDays,ctx.timezone)) {
        candidates.push({ at,reason:'плановая рассылка опросов на игры' }); break;
      }
    }
  }
  candidates.sort((a,b)=>a.at.getTime()-b.at.getTime());
  const next = candidates[0];
  if (!next) return { text:'отправка не запланирована',detail:'Нет подходящего запуска до начала игры; проверь расписание и горизонт рассылки',kind:'no' };
  const when = new Intl.DateTimeFormat('ru-RU',{ timeZone:ctx.timezone,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).format(next.at);
  return { text:`${game.poll_last_error ? 'повтор запланирован' : 'запланирована отправка'} ${when}`,
    detail:`${next.reason} · ${ctx.timezone}${game.poll_last_error ? ` · Последняя ошибка: ${game.poll_last_error}` : ''}`,kind:game.poll_last_error?'no':'black' };
}
