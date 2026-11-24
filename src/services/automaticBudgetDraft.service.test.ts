import '../test/env.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import type { StatsCheck } from './automaticGameStats.service.js';
import { completeStatsFingerprint, refreshAndSendCompletedDraft } from './automaticBudgetDraft.service.js';

const plan = {
  url: 'https://moscow.ilovebasket.ru/games/1?apiUrl=https://reg.infobasket.su',
  team: 'BLACK' as const,
  teamName: 'Yandex Black', opponent: 'Opponent', date: '2026-11-29', fee: 1000,
  playedCount: 1, coachPresent: true, calendarEventId: 'event-1',
  participants: [{ name: 'Игрок Один', matched_player_id: 1, tg_login: '@one' }],
};
const readyCheck = (fee = 1000): StatsCheck => ({
  ready: true, error: null, plan: { ...plan, fee },
  game: {
    id: 'scheduled-1', source: 'MLBL', source_url: 'https://example.com', external_id: '1',
    team: 'BLACK', team_a: 'Yandex Black', team_b: 'Opponent', game_date: '2026-11-29',
    game_time: '20:00', location: null, details_url: plan.url, calendar_event_id: 'event-1',
    present_in_source: true, coach_present: true, coach_conflict: false, duplicate_group: null,
    poll_chat_id: null, poll_message_id: null, poll_id: null, poll_sent_at: null,
    poll_error: null, poll_attempted_at: null, created_at: '2026-11-01', updated_at: '2026-11-01',
  },
});
test('финальный результат пересчитывает черновик и отправляется один раз на отпечаток', async () => {
  const db = new PGlite();
  const sql = (text: string, params?: unknown[]) => params ? db.query(text, params) : db.exec(text).then((r) => r.at(-1)!);
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release() {} }));
  try {
    await migrate();
    await db.query(`insert into budgets(team,month,year,details) values('COMMON',12,2026,$1)`, [JSON.stringify({
      total_players: 1, players_team: 1, players_other: 0, paid_gym_sessions: 0,
      coach_sessions: 0, gym_per_person: 0, coach_per_person: 0, base_per_person: 0,
    })]);
    let builds = 0;
    let sends = 0;
    const deps = {
      build: async () => {
        builds++;
        return [{ team: 'COMMON' as const, budgetId: 1, message: 'draft', gamesCount: 1,
          result: { team: 'RED' as const, month: 12, year: 2026, base_per_person: 0, charges: [], details: {
            total_players: 1, players_team: 1, players_other: 0, paid_gym_sessions: 0,
            coach_sessions: 0, gym_per_person: 0, coach_per_person: 0, base_per_person: 0,
          } } }];
      },
      send: async () => { sends++; return { sent: 1, deliveries: 1, failures: 0 }; },
    };
    const api = {} as never;
    assert.equal(await refreshAndSendCompletedDraft(api, 12, 2026, [readyCheck()], deps), 'sent');
    assert.equal(await refreshAndSendCompletedDraft(api, 12, 2026, [readyCheck()], deps), 'already-sent');
    assert.equal(builds, 1);
    assert.equal(sends, 1);

    assert.equal(await refreshAndSendCompletedDraft(api, 12, 2026, [readyCheck(1200)], deps), 'sent');
    assert.equal(builds, 2);
    assert.equal(sends, 2);

    const failedDelivery = { ...deps, send: async () => ({ sent: 1, deliveries: 0, failures: 1 }) };
    await assert.rejects(
      refreshAndSendCompletedDraft(api, 12, 2026, [readyCheck(1300)], failedDelivery),
      /не доставлен ни одному администратору/,
    );
    assert.equal(await refreshAndSendCompletedDraft(api, 12, 2026, [readyCheck(1300)], deps), 'sent');
    assert.equal(builds, 4);
    assert.equal(sends, 3);
  } finally {
    mock.restoreAll();
    await db.close();
    await pool.end();
  }
});

test('неполный набор статистики не имеет финального отпечатка', () => {
  assert.equal(completeStatsFingerprint([]), null);
  assert.equal(completeStatsFingerprint([{ ...readyCheck(), ready: false, plan: undefined, error: 'ещё не сыграна' }]), null);
});
