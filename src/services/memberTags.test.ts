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
    getChatMember: async (_chat: number, id: number) => ({ status: id === 3 ? 'administrator' : id === 4 ? 'left' : 'member' }),
    setChatMemberTag: async (_chat: number, id: number, tag: string) => { tagged.push([id, tag]); },
  } as unknown as Api;
  const result = await syncMemberTags(api, [base, { ...base, tg_user_id: 2, active: false },
    { ...base, tg_user_id: 3, active: false }, { ...base, tg_user_id: 4 }, { ...base, tg_user_id: null }]);
  assert.deepEqual(tagged, [[1, 'Active'], [2, 'Non-active']]);
  assert.deepEqual(result, { tagged: 2, skippedAdmins: 1, absent: 1, missingId: 1, errors: 0 });
});
