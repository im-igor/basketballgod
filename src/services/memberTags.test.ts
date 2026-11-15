import '../test/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api } from 'grammy';
import type { Player } from '../db/types.js';
import { memberTag, syncMemberTags } from './memberTags.service.js';

test('Telegram использует пять статусов, не меняет титулы админов и не трогает отсутствующих', async () => {
  assert.deepEqual(['RED', 'BLACK', 'BOTH', 'NONE'].map(team => memberTag(team as Player['team'])),
    ['Red', 'Black', 'Black/Red', 'Active']);
  for (const team of ['RED', 'BLACK', 'BOTH', 'NONE'] as const) assert.equal(memberTag(team, false), 'Non-active');
  const base: Player = { id: 1, tg_user_id: 1, name: 'Игрок', tg_login: '@player', team: 'NONE',
    active: true, is_employee: false, active_from: null, active_to: null, notes: null };
  const tagged: Array<[number, string]> = [];
  const api = {
    getChatMember: async (_chat: number, id: number) => ({
      status: id === 3 ? 'administrator' : id === 4 ? 'left' : 'member',
      tag: id === 1 ? 'Active' : undefined,
    }),
    setChatMemberTag: async (_chat: number, id: number, tag: string) => { tagged.push([id, tag]); },
  } as unknown as Api;
  const result = await syncMemberTags(api, [base, { ...base, tg_user_id: 2, active: false },
    { ...base, tg_user_id: 3, active: false }, { ...base, tg_user_id: 4 }, { ...base, tg_user_id: null }],
  { minWriteIntervalMs: 0 });
  assert.deepEqual(tagged, [[2, 'Non-active']]);
  assert.deepEqual(result, {
    tagged: 1,
    alreadyCorrect: 1,
    skippedAdmins: 1,
    absent: 1,
    missingId: 1,
    errors: 0,
  });
});

test('повторяет обновление после Telegram 429 и ждёт retry_after', async () => {
  const player: Player = {
    id: 1,
    tg_user_id: 1,
    name: 'Игрок',
    tg_login: '@player',
    team: 'BOTH',
    active: true,
    is_employee: false,
    active_from: null,
    active_to: null,
    notes: null,
  };
  let attempts = 0;
  const waits: number[] = [];
  const api = {
    getChatMember: async () => ({ status: 'member', tag: 'Active' }),
    setChatMemberTag: async () => {
      attempts++;
      if (attempts === 1) throw { error_code: 429, parameters: { retry_after: 2 } };
    },
  } as unknown as Api;

  const result = await syncMemberTags(api, [player], {
    sleep: async milliseconds => { waits.push(milliseconds); },
    minWriteIntervalMs: 0,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [3000]);
  assert.deepEqual(result, {
    tagged: 1,
    alreadyCorrect: 0,
    skippedAdmins: 0,
    absent: 0,
    missingId: 0,
    errors: 0,
  });
});
