import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { listEvents, upsertScheduledCalendarEvent, type ScheduledCalendarEvent } from './calendar.js';
import { parseTags } from './tags.js';

test('импорт и повторная синхронизация игр RED используют MIXED, BLACK — ALL_BLACK', async () => {
  const fixture: ScheduledCalendarEvent = {
    source: 'LCHB', externalId: '123', team: 'RED', teamA: 'RED', teamB: 'Opponent',
    gameDate: '2026-11-01', gameTime: '18:00', location: null,
    sourceUrl: 'https://example.com/schedule', detailsUrl: null,
    calendarEventId: 'existing-event', coachPresent: true, coachConflict: false,
  };
  const updates: Array<{ eventId?: string; requestBody?: { description?: string | null } }> = [];
  const update = mock.method(calendar_v3.Resource$Events.prototype, 'update', async (args) => {
    updates.push(args);
    return { data: {} };
  });
  try {
    for (const team of ['RED', 'RED', 'BLACK'] as const) {
      await upsertScheduledCalendarEvent({ ...fixture, team });
    }
    assert.deepEqual(updates.map((args) => parseTags(args.requestBody?.description).INVOLVED),
      ['MIXED', 'MIXED', 'ALL_BLACK']);
    assert.ok(updates.every((args) => args.eventId === 'existing-event'));
    assert.ok(updates.every((args) => parseTags(args.requestBody?.description).TYPE === 'GAME'));
  } finally {
    update.mock.restore();
  }
});

test('MIXED сохраняет остальные теги события при чтении календаря', () => {
  assert.deepEqual(parseTags('TYPE=GAME\nGYM=FREE\nCOACH=PAID\nINVOLVED=MIXED'), {
    TYPE: 'GAME', GYM: 'FREE', COACH: 'PAID', INVOLVED: 'MIXED',
  });
});

test('чтение календаря не обрывается после первой страницы, метка импорта лиги сохраняется', async () => {
  const tokens: Array<string | undefined> = [];
  const list = mock.method(calendar_v3.Resource$Events.prototype, 'list', async (args: { pageToken?: string }) => {
    tokens.push(args.pageToken);
    return { data: {
      items: [{ id: args.pageToken ? 'manual' : 'league', summary: 'Игра A - B',
        start: { date: '2026-11-01' }, description: 'TYPE=GAME',
        extendedProperties: args.pageToken ? undefined : { private: { basketballgodSource: 'LCHB' } },
      }],
      nextPageToken: args.pageToken ? undefined : 'next',
    } };
  });
  try {
    const events = await listEvents('RED', new Date('2026-10-01Z'), new Date('2027-01-01Z'));
    assert.deepEqual(tokens, [undefined, 'next']);
    assert.deepEqual(events.map((e) => e.uid), ['league', 'manual']);
    assert.equal(events[0]!.importedSource, 'LCHB');
    assert.equal(events[1]!.importedSource, undefined);
  } finally {
    list.mock.restore();
  }
});
