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

/**
 * Согласовать даты активности по правилу «побеждает поздняя дата»:
 * если «активен по» раньше «активен с», значит была переактивация, а старая дата
 * окончания устарела — обнуляем её. Так противоречивые даты (конец раньше начала)
 * не выкидывают игрока из расчёта. Применяется при импорте из таблицы, сохранении
 * в админке и в самом расчёте бюджета.
 */
export function reconcileActivityDates<T extends string | Date | null>(
  activeFrom: T,
  activeTo: T,
): { active_from: T; active_to: T | null } {
  if (
    activeFrom &&
    activeTo &&
    new Date(activeTo as string | Date).getTime() < new Date(activeFrom as string | Date).getTime()
  ) {
    return { active_from: activeFrom, active_to: null };
  }
  return { active_from: activeFrom, active_to: activeTo };
}
