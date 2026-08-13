import { env } from '../config/env.js';

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Компоненты даты/времени в заданной таймзоне (по умолчанию env.TZ = Europe/Moscow).
 * Календарь Google отдаёт ISO со смещением (…+03:00), но `Date`-геттеры считают
 * в TZ процесса (в контейнере — UTC), из-за чего время «уезжало» на −3 часа.
 * Здесь форматируем строго в целевой TZ, независимо от TZ процесса.
 */
function partsInTZ(d: Date, tz: string = env.TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    day: get('day'),
    month: get('month'),
    year: get('year'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

export function monthLabel(month: number, year: number): string {
  return `${MONTHS_RU[month - 1] ?? month} ${year}`;
}

export function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** dd.MM.yyyy — формат для отображения пользователю (в таймзоне env.TZ). */
export function toRuDate(iso: string | Date | null): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = partsInTZ(d);
  return `${p.day}.${p.month}.${p.year}`;
}

/**
 * ISO `YYYY-MM-DD` (или Date) → `dd.mm.yyyy` (или ''). В отличие от `toRuDate`
 * работает со строкой напрямую, без разбора в Date, — для «календарных» дат
 * без времени (active_from/active_to), где таймзона не нужна.
 */
export function isoToRu(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (v instanceof Date) {
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${v.getFullYear()}`;
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Человекочитаемая дата+время события для вопроса опроса (в таймзоне env.TZ). */
export function eventLabel(iso: string, withTime: boolean): string {
  const p = partsInTZ(new Date(iso));
  const base = `${WEEKDAYS_RU[p.weekday] ?? ''} ${p.day}-${p.month}-${p.year}`;
  if (!withTime) return base;
  return `${base} ${p.hour}:${p.minute}`;
}

/** Границы месяца [first, nextFirst). */
export function monthRange(month: number, year: number): { from: Date; to: Date } {
  return { from: new Date(year, month - 1, 1), to: new Date(year, month, 1) };
}

export function firstDayNextMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

export function lastDayCurrentMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0);
}

/** Месяц/год, следующие за датой now (для бюджета на следующий месяц). */
export function nextMonthOf(now: Date): { month: number; year: number } {
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}
