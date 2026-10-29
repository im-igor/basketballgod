import { matchesScheduledTeam } from './schedule.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduledGame } from '../db/types.js';
import {
  groupScheduleDuplicates,
  normalizeScheduledTeamName,
  scheduledFixtureKey,
} from './schedule.js';

function fixture(overrides: Partial<ScheduledGame>): ScheduledGame {
  return {
    id: '1',
    source: 'LCHB',
    source_url: 'https://example.test',
    external_id: 'one',
    team: 'RED',
    team_a: 'Yandex Red',
    team_b: 'Транснефть',
    game_date: '2026-10-04',
    game_time: '21:10:00',
    location: null,
    details_url: null,
    calendar_event_id: null,
    coach_present: null,
    coach_override: false,
    coach_conflict: false,
    present_in_source: true,
    duplicate_notified_at: null,
    poll_pending: true,
    poll_sent_at: null,
    poll_last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

test('названия команд нормализуются по регистру, пробелам и е/ё', () => {
  assert.equal(normalizeScheduledTeamName('  Ёлки   YANDEX  '), 'елки yandex');
});

test('порядок команд не влияет на ключ матча', () => {
  const direct = fixture({ team_a: 'Yandex Red', team_b: 'Транснефть' });
  const reversed = fixture({ team_a: '  транснефть ', team_b: 'YANDEX RED' });
  assert.equal(scheduledFixtureKey(direct), scheduledFixtureKey(reversed));
});

test('дублем считается только тот же состав команд в ту же дату и время', () => {
  const original = fixture({ id: '1', external_id: 'old' });
  const duplicate = fixture({ id: '2', external_id: 'new', team_a: 'транснефть', team_b: 'Yandex  Red' });
  const otherDate = fixture({ id: '3', external_id: 'date', game_date: '2026-10-05' });
  const otherTime = fixture({ id: '4', external_id: 'time', game_time: '21:20:00' });
  const groups = groupScheduleDuplicates([original, duplicate, otherDate, otherTime]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.games.map((game) => game.id), ['1', '2']);
});


test('сокращение названия ЛЧБ в расписании сопоставляется с полным протоколом', () => {
  assert.equal(matchesScheduledTeam('Лига Цифровой Экономи...','Лига Цифровой Экономики'),true);
  assert.equal(matchesScheduledTeam('Лига Цифровой Экономи…','Лига Цифровой Экономики'),true);
  assert.equal(matchesScheduledTeam('Лига...','Лига Цифровой Экономики'),false);
  assert.equal(matchesScheduledTeam('MARKS GROUP','Yandex Red'),false);
});
