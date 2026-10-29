import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { nextScheduleCheck, pollScheduleContext, scheduledPollStatus } from './pollSchedule.js';
import type { CronConfig, ScheduledGame } from '../db/types.js';
import type { CronJobWindow } from '../db/repos/cronJobWindows.repo.js';
const now = new Date('2026-10-29T10:07:00Z'); // четверг 13:07 МСК
const cfg = { timezone:'Europe/Moscow',poll_game_weekday:5,poll_game_time:'12:00',poll_game_horizon_days:7,
  schedule_import_enabled:true,schedule_import_interval_minutes:15,schedule_import_send_polls:true } as CronConfig;
const game = { game_date:'2026-11-01',game_time:'18:30',created_at:'2026-10-28T10:00:00Z',
  calendar_event_id:'calendar-event',poll_pending:true,poll_sent_at:null,poll_last_error:null } as ScheduledGame;
const window = { job_key:'game-polls',window_started_at:'2026-10-23T09:00:00Z',
  window_until:'2026-11-02T21:00:00Z',completed_at:'2026-10-23T09:01:00Z' } as CronJobWindow;
const context = (patch:Partial<CronConfig> = {}, saved: CronJobWindow | null = window) =>
  pollScheduleContext({ ...cfg,...patch },saved,now,{ timezone:'Europe/Moscow',cron:'0 12 * * 5',horizonDays:7 });

test('ближайшая проверка совпадает с cron, изменение интервала меняет время', () => {
  assert.equal(nextScheduleCheck(now,15,'Europe/Moscow')!.toISOString(),'2026-10-29T10:15:00.000Z');
  assert.equal(nextScheduleCheck(now,30,'Europe/Moscow')!.toISOString(),'2026-10-29T10:30:00.000Z');
  assert.equal(nextScheduleCheck(now,120,'Europe/Moscow')!.toISOString(),'2026-10-29T11:00:00.000Z');
  assert.equal(nextScheduleCheck(now,1440,'Europe/Moscow')!.toISOString(),'2026-10-30T00:00:00.000Z');
  assert.match(scheduledPollStatus(game,context()).text,/29\.10\.2026.*13:15/);
  assert.match(scheduledPollStatus(game,context({ schedule_import_interval_minutes:30 })).text,/13:30/);
});

test('за пределами активного окна показывается пятничная плановая рассылка', () => {
  const oldWindow = { ...window,window_until:'2026-10-30T21:00:00Z' };
  const status = scheduledPollStatus(game,context({},oldWindow));
  assert.match(status.text,/30\.10\.2026.*12:00/);
  assert.match(status.detail,/плановая рассылка/);
});

test('выключенная автопроверка, выключенные внеочередные опросы и отсутствие окна оставляют плановую рассылку', () => {
  for (const ctx of [context({ schedule_import_enabled:false }),context({ schedule_import_send_polls:false }),context({},null)]) {
    assert.match(scheduledPollStatus(game,ctx).text,/30\.10\.2026.*12:00/);
  }
});

test('старая игра не обещает внеочередную отправку, дальняя игра ждёт подходящего горизонта', () => {
  assert.match(scheduledPollStatus({ ...game,created_at:'2026-10-22T10:00:00Z' },context()).text,/30\.10\.2026/);
  const distant = scheduledPollStatus({ ...game,game_date:'2026-11-22' },context());
  assert.match(distant.text,/20\.11\.2026.*12:00/);
});

test('истечение окна до следующей проверки не обещает отправку на ней', () => {
  assert.match(scheduledPollStatus(game,context({}, { ...window,window_until:'2026-10-29T10:10:00Z' })).text,/30\.10\.2026/);
});

test('отправленные, просроченные и недоступные опросы различаются; ошибка показывает время повтора', () => {
  assert.equal(scheduledPollStatus({ ...game,poll_sent_at:new Date() },context()).text,'отправлен');
  assert.match(scheduledPollStatus({ ...game,game_date:'2026-10-28' },context()).text,/игра уже началась/);
  assert.match(scheduledPollStatus({ ...game,calendar_event_id:null },context()).text,/нет связи/);
  const retry = scheduledPollStatus({ ...game,poll_last_error:'Telegram unavailable' },context());
  assert.match(retry.text,/повтор запланирован.*13:15/);
  assert.match(retry.detail,/Telegram unavailable/);
});

test('не обещает отправку, если до матча нет подходящего запуска', () => {
  assert.match(scheduledPollStatus({ ...game,game_date:'2026-10-29',game_time:'13:10' },context({},null)).text,/отправка не запланирована/);
});
