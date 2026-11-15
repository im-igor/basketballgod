import '../test/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUpcomingPollEvent } from './poll.service.js';
import { inActivePollWindow } from '../domain/pollSchedule.js';
import type { ScheduledGame } from '../db/types.js';
import type { CronJobWindow } from '../db/repos/cronJobWindows.repo.js';

test('голосовалка не включает уже начавшееся событие, даже если оно ещё идёт', () => {
  const now = new Date('2026-11-15T19:00:00Z');
  assert.equal(isUpcomingPollEvent({ start: '2026-11-15T18:10:00Z' }, now), false);
  assert.equal(isUpcomingPollEvent({ start: '2026-11-15T19:10:00Z' }, now), true);
  assert.equal(isUpcomingPollEvent({ start: 'invalid' }, now), false);
});

test('внеочередная голосовалка тоже не отправляется после начала игры', () => {
  const game = {
    game_date: '2026-11-15', game_time: '21:10', created_at: '2026-11-15T18:30:00Z',
  } as ScheduledGame;
  const window = {
    job_key: 'game-polls', window_started_at: '2026-11-15T18:00:00Z',
    window_until: '2026-11-22T19:00:00Z', completed_at: '2026-11-15T18:01:00Z',
    updated_at: '2026-11-15T18:01:00Z',
  } satisfies CronJobWindow;
  assert.equal(inActivePollWindow(game, window, new Date('2026-11-15T19:00:00Z')), false);
  assert.equal(inActivePollWindow({ ...game, game_time: '22:10' }, window, new Date('2026-11-15T19:00:00Z')), true);
});
