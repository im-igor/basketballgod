import { firstDayNextMonth, lastDayCurrentMonth, toISODate } from './dates.js';

/**
 * Логика дат активности игрока (порт из n8n /active):
 *  - active=YES → active_from = 1-е число следующего месяца, active_to не трогаем
 *  - active=NO  → active_to   = последнее число текущего месяца
 */
export function computeActivityDates(
  active: boolean,
  now = new Date(),
): { active_from: string | null; active_to: string | null } {
  if (active) {
    return { active_from: toISODate(firstDayNextMonth(now)), active_to: null };
  }
  return { active_from: null, active_to: toISODate(lastDayCurrentMonth(now)) };
}
