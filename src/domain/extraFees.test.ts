import '../test/env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtraFee, Game } from '../db/types.js';
import { extraFeeForm, extraFeesForPlayer, sumMoney } from './extraFees.js';
import { buildBudgetMessage } from './messages.js';

const fee: ExtraFee = {
  id: 1, title: 'Меддопуск МЛБЛ', amount_per_player: 380, team: 'BLACK',
  mode: 'PLAYED', league: 'MLBL', start_period: 202610, end_period: 202705, active: true,
};
const game: Game = {
  id: 1, team: 'BLACK', event_uid: null, opponent: 'Соперник', played_on: '2026-09-20',
  stat_url: 'https://moscow.ilovebasket.ru/games/1090210?apiUrl=https://reg.infobasket.su#protocol',
  fee_per_player: 500, coach_present: true, judge: false, month: 10, year: 2026,
  participants: [{ name: 'Игрок 1', matched_player_id: 1 }],
};
const input: Parameters<typeof extraFeesForPlayer>[0] = {
  playerId: 1, login: '@player1', team: 'BLACK', budgetId: 10, period: 202610,
  fees: [fee], allocations: [], games: [game],
};
const item = { fee_id: 1, title: fee.title, amount: 380 };
const allocation = { ...item, player_id: 1, tg_login: '@player1', budget_id: 10 };

test('меддопуск 380 начисляется один раз независимо от количества игр', () => {
  assert.deepEqual(extraFeesForPlayer({ ...input, games: [game, game, game] }), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...input, playerId: 2, login: '@bench' }), []);
});

test('кросс-команда: выход RED за BLACK попадает в бюджет RED', () => {
  assert.deepEqual(extraFeesForPlayer({ ...input, team: 'RED' }), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...input, games: [{ ...game, team: 'RED' }] }), []);
});

test('МЛБЛ не включает ЛЧБ, ручные и неизвестные протоколы', () => {
  for (const stat_url of [null, 'invalid', 'https://basketball.businesschampions.ru/matches/123/']) {
    assert.deepEqual(extraFeesForPlayer({ ...input, games: [{ ...game, stat_url }] }), []);
  }
});

test('ANY включает ручные MIXED-игры при выборе обеих команд, даже с нулевым игровым взносом', () => {
  assert.deepEqual(extraFeesForPlayer({
    ...input, fees: [{ ...fee, league: 'ANY', team: 'BOTH' }],
    games: [{ ...game, team: 'MIXED', stat_url: null, fee_per_player: 0 }],
  }), [item]);
});

test('месяц начисления берётся из бюджета, а не из даты матча', () => {
  assert.deepEqual(extraFeesForPlayer(input), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...input, games: [{ ...game, month: 9 }] }), []);
});

test('границы сбора включительны и работают при переходе года', () => {
  const at = (period: number) => extraFeesForPlayer({
    ...input, period, games: [{ ...game, month: period % 100, year: Math.floor(period / 100) }],
  });
  assert.deepEqual(at(202609), []);
  assert.deepEqual(at(202610), [item]);
  assert.deepEqual(at(202701), [item]);
  assert.deepEqual(at(202705), [item]);
  assert.deepEqual(at(202706), []);
});

test('начисленный, даже неоплаченный сбор не повторяется в другом месяце или команде', () => {
  assert.deepEqual(extraFeesForPlayer({
    ...input, budgetId: 11, period: 202611, allocations: [allocation],
    games: [{ ...game, month: 11 }],
  }), []);
  assert.deepEqual(extraFeesForPlayer({ ...input, budgetId: 12, team: 'RED', allocations: [allocation] }), []);
});

test('пересборка сохраняет назначение и снимок суммы даже после завершения сбора', () => {
  assert.deepEqual(extraFeesForPlayer({
    ...input, games: [], allocations: [allocation], fees: [{ ...fee, active: false, amount_per_player: 999 }],
  }), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...input, fees: [{ ...fee, active: false }] }), []);
});

test('идентичность по id сохраняется при смене логина, по логину — при удалении игрока', () => {
  assert.deepEqual(extraFeesForPlayer({ ...input, login: '@new', allocations: [allocation] }), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...input, playerId: null, allocations: [{ ...allocation, player_id: null }] }), [item]);
});

test('всем участникам бюджета: игры не нужны, начисляется только в выбранном месяце', () => {
  const allInput = { ...input, games: [], fees: [{ ...fee, mode: 'BUDGET' as const, league: 'ANY' as const, end_period: null }] };
  assert.deepEqual(extraFeesForPlayer(allInput), [item]);
  assert.deepEqual(extraFeesForPlayer({ ...allInput, period: 202611 }), []);
  assert.deepEqual(extraFeesForPlayer({ ...allInput, team: 'RED' }), []);
  assert.deepEqual(extraFeesForPlayer({ ...allInput, fees: [{ ...allInput.fees[0]!, team: 'BOTH' }], team: 'RED' }), [item]);
});

test('несколько независимых сборов складываются без потери копеек', () => {
  const items = extraFeesForPlayer({ ...input, fees: [fee, { ...fee, id: 2, amount_per_player: 0.1 }, { ...fee, id: 3, amount_per_player: 0.2 }] });
  assert.equal(items.length, 3);
  assert.equal(sumMoney(items.map((x) => x.amount)), 380.3);
});

const form = { title: ' Меддопуск ', amount_per_player: '380', team: 'BLACK', mode: 'PLAYED', league: 'MLBL', start_period: '2026-10', end_period: '' };
test('форма валидирует сумму, режим, команду и календарный период', () => {
  const parsed = extraFeeForm.parse(form);
  assert.equal(parsed.title, 'Меддопуск');
  assert.equal(parsed.start_period, 202610);
  assert.equal(parsed.end_period, null);
  for (const patch of [
    { title: ' ' }, { amount_per_player: '0' }, { amount_per_player: '-380' },
    { amount_per_player: 'NaN' }, { amount_per_player: 'Infinity' }, { amount_per_player: '0.001' },
    { team: 'MIXED' }, { mode: 'MONTHLY' }, { league: 'unknown' },
    { start_period: '2026-13' }, { start_period: '2023-12' }, { end_period: '2026-09' },
  ]) assert.equal(extraFeeForm.safeParse({ ...form, ...patch }).success, false, JSON.stringify(patch));
  const all = extraFeeForm.parse({ ...form, mode: 'BUDGET', end_period: '2026-09' });
  assert.equal(all.league, 'ANY');
  assert.equal(all.end_period, null);
});

test('Telegram показывает название, сумму разового сбора и персональную расшифровку, экранируя HTML', () => {
  const message = buildBudgetMessage({
    team: 'BLACK', month: 10, year: 2026,
    details: { total_players: 2, players_team: 2, players_other: 0, paid_gym_sessions: 0, coach_sessions: 0, gym_per_person: 1000, coach_per_person: 0, base_per_person: 1000 },
    tariffs: { coach_per_game: 0, coach_per_session: 0, gym_paid_price: 0, locker_rent_price: 0, referee_default: 0 },
    charges: [
      { name: 'Игрок Первый', tg_login: '@first', game_amount: 500, extra_items: [{ ...item, title: 'Мед <допуск>' }], amount: 1880, paid: false },
      { name: 'Игрок Второй', tg_login: '@second', game_amount: 0, extra_items: [], amount: 1000, paid: true },
    ], games: [], payment: { sberUrl: '', tbankUrl: '' },
  });
  assert.match(message, /Мед &lt;допуск&gt;: \+380 руб\.\/чел\./);
  assert.match(message, /@first 1880 \(в т\.ч\. разовые: Мед &lt;допуск&gt; \+380\)/);
  assert.match(message, /@second 1000$/);
});
