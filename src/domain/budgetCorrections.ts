import type { Budget, BudgetCorrection, BudgetEventSnapshot, PayoutCorrection, Tariffs, Team } from '../db/types.js';
import type { CalendarEvent } from '../google/calendar.js';
import { monthLabel } from './dates.js';
import { createHash } from 'node:crypto';

const TEAMS: Team[] = ['RED', 'BLACK'];

function publishedSnapshot(red: Budget | null, black: Budget | null): BudgetEventSnapshot | undefined {
  return (red?.message_id != null ? red.details?.event_snapshot : undefined) ??
    (black?.message_id != null ? black.details?.event_snapshot : undefined);
}

export function snapshotEvents(events: CalendarEvent[], tariffs: Tariffs): BudgetEventSnapshot {
  return {
    events: events.map((e) => ({
      uid: e.uid, team: e.team, start: e.start,
      paid_coach: e.tags.TYPE === 'TRAINING' && e.tags.COACH === 'PAID',
      paid_gym: e.tags.GYM === 'PAID',
    })).filter((e) => e.paid_coach || e.paid_gym),
    coach_rate: tariffs.coach_per_session,
    gym_rate: tariffs.gym_paid_price,
    locker_rate: tariffs.locker_rent_price,
  };
}

export interface CalendarDifference {
  coach_delta: Record<Team, number>;
  gym_delta: number;
  changed: string[];
}

export function calendarFingerprint(events: CalendarEvent[]): string {
  const rows = snapshotEvents(events, {
    coach_per_session: 0, coach_per_game: 0, gym_paid_price: 0,
    locker_rent_price: 0, referee_default: 0,
  }).events.map((e) => `${e.team}:${e.uid}:${e.start}:${e.paid_coach}:${e.paid_gym}`).sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** Разница относительно опубликованного расчёта; для старых бюджетов — по сохранённым счётчикам. */
export function calendarDifference(
  red: Budget | null, black: Budget | null, current: CalendarEvent[],
): CalendarDifference {
  const snapshot = publishedSnapshot(red, black);
  const active = snapshotEvents(current, {
    coach_per_session: 0, coach_per_game: 0, gym_paid_price: 0,
    locker_rent_price: 0, referee_default: 0,
  }).events;
  const coachCount = (events: typeof active, team: Team) =>
    events.filter((e) => e.team === team && e.paid_coach).length;
  const gymCount = (events: typeof active) => new Set(events.filter((e) => e.paid_gym).map((e) => e.uid)).size;
  const originalCoach = {
    RED: red?.message_id != null ? snapshot
      ? coachCount(snapshot.events, 'RED') : red.details?.coach_sessions ?? 0 : coachCount(active, 'RED'),
    BLACK: black?.message_id != null ? snapshot
      ? coachCount(snapshot.events, 'BLACK') : black.details?.coach_sessions ?? 0 : coachCount(active, 'BLACK'),
  };
  const originalGym = (red?.message_id != null || black?.message_id != null)
    ? snapshot ? gymCount(snapshot.events) : red?.details?.paid_gym_sessions ?? black?.details?.paid_gym_sessions ?? 0
    : gymCount(active);
  const changed: string[] = [];
  if (snapshot) {
    const currentByKey = new Map(active.map((e) => [`${e.team}:${e.uid}`, e]));
    const originalByKey = new Map(snapshot.events.map((e) => [`${e.team}:${e.uid}`, e]));
    for (const e of snapshot.events) {
      const now = currentByKey.get(`${e.team}:${e.uid}`);
      if ((e.paid_coach && !now?.paid_coach) || (e.paid_gym && !now?.paid_gym))
        changed.push(`${e.start.slice(0, 10)} ${e.team}: отменено или изменено`);
      else if (now && e.start !== now.start)
        changed.push(`${e.start.slice(0, 10)} ${e.team}: перенесено на ${now.start.slice(0, 10)}`);
    }
    for (const e of active) {
      const before = originalByKey.get(`${e.team}:${e.uid}`);
      if ((e.paid_coach && !before?.paid_coach) || (e.paid_gym && !before?.paid_gym))
        changed.push(`${e.start.slice(0, 10)} ${e.team}: добавлено или изменено`);
    }
  }
  return {
    coach_delta: {
      RED: coachCount(active, 'RED') - originalCoach.RED,
      BLACK: coachCount(active, 'BLACK') - originalCoach.BLACK,
    },
    gym_delta: gymCount(active) - originalGym,
    changed: [...new Set(changed)],
  };
}

export function correctionNote(c: Pick<BudgetCorrection, 'source_month' | 'source_year' | 'coach_delta' | 'gym_delta'>): string {
  const coachDelta = c.coach_delta.RED + c.coach_delta.BLACK;
  const parts = [
    coachDelta ? `тренер ${coachDelta > 0 ? '+' : ''}${coachDelta}` : '',
    c.gym_delta ? `зал ${c.gym_delta > 0 ? '+' : ''}${c.gym_delta}` : '',
  ].filter(Boolean);
  return parts.length ? `Корректировка за ${monthLabel(c.source_month, c.source_year)}: ${parts.join(', ')}.` : '';
}

export function proposeCorrection(
  month: number, year: number, red: Budget | null, black: Budget | null,
  current: CalendarEvent[], tariffs: Tariffs,
): BudgetCorrection {
  const difference = calendarDifference(red, black, current);
  const snapshot = publishedSnapshot(red, black);
  const currentSnapshot = snapshotEvents(current, tariffs).events;
  const published = red?.message_id != null || black?.message_id != null;
  const c: BudgetCorrection = {
    source_month: month, source_year: year,
    coach_delta: difference.coach_delta, gym_delta: difference.gym_delta,
    coach_rate: snapshot?.coach_rate ?? tariffs.coach_per_session,
    gym_rate: snapshot?.gym_rate ?? tariffs.gym_paid_price,
    note: '', note_edited: false,
    reviewed: difference.changed.length === 0 && difference.gym_delta === 0 &&
      TEAMS.every((team) => difference.coach_delta[team] === 0),
    source_fingerprint: calendarFingerprint(current),
    source_snapshot: currentSnapshot,
    quantities_edited: false,
    source_changes: difference.changed,
    rate_estimated: published && !snapshot,
  };
  c.note = correctionNote(c);
  return c;
}

export function payoutCorrections(
  red: Budget | null, black: Budget | null, current: CalendarEvent[], tariffs: Tariffs,
): PayoutCorrection[] {
  const diff = calendarDifference(red, black, current);
  const result: PayoutCorrection[] = [];
  for (const team of TEAMS) if (diff.coach_delta[team]) result.push({
    component: 'COACH', team, sessions: diff.coach_delta[team],
    amount: diff.coach_delta[team] * tariffs.coach_per_session,
    note: `${team}: ${diff.coach_delta[team] > 0 ? 'добавлено' : 'отменено'} ${Math.abs(diff.coach_delta[team])} трен. по сравнению с опубликованным бюджетом`,
  });
  if (diff.gym_delta) result.push({
    component: 'GYM', sessions: diff.gym_delta,
    amount: diff.gym_delta * tariffs.gym_paid_price,
    note: `${diff.gym_delta > 0 ? 'Добавлено' : 'Отменено'} ${Math.abs(diff.gym_delta)} платн. аренды по сравнению с опубликованным бюджетом`,
  });
  return result;
}
