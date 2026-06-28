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

export function monthLabel(month: number, year: number): string {
  return `${MONTHS_RU[month - 1] ?? month} ${year}`;
}

export function toISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** dd.MM.yyyy — формат для отображения пользователю. */
export function toRuDate(iso: string | Date | null): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/** Человекочитаемая дата+время события для вопроса опроса. */
export function eventLabel(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  const wd = WEEKDAYS_RU[d.getDay()] ?? '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const base = `${wd} ${dd}-${mm}-${d.getFullYear()}`;
  if (!withTime) return base;
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${base} ${hh}:${min}`;
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
