import '../test/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { buildAndSaveBudgets } from './budget.service.js';
import { sendBudgetToChat } from './notify.service.js';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { upsertScheduledGame } from '../db/repos/scheduledGames.repo.js';
import { checkAutomaticGameStats, importAutomaticGameStats, sourcePeriod, planFingerprint } from './automaticGameStats.service.js';
import { matchPlayer, validateGame, registerValidatedGames, registerManualGame, type GamePlan } from './gameFee.service.js';
import type { Player } from '../db/types.js';

const db = new PGlite();
const sql = async (text: string, params?: unknown[]) => {
  const result = params ? await db.query(text, params) : (await db.exec(text)).at(-1)!;
  for (const field of result.fields) if (field.dataTypeID === 1700) {
    for (const row of result.rows as Record<string, unknown>[]) {
      if (row[field.name] !== null) row[field.name] = Number(row[field.name]);
    }
  }
  return { ...result, rowCount: result.affectedRows || result.rows.length };
};
const now = new Date('2026-10-21T08:00:00Z');
const later = new Date('2026-10-21T09:00:00Z');
const url = 'https://moscow.ilovebasket.ru/games/123?apiUrl=https://reg.infobasket.su';
const plan: GamePlan = { url, team: 'BLACK', teamName: 'Yandex Black', opponent: 'Opponent',
  date: '2026-10-20', fee: 1000, playedCount: 5, coachPresent: true, calendarEventId: 'event',
  participants: Array.from({ length: 5 }, (_, i) => ({ name: `Имя Фамилия${i}`, matched_player_id: i + 1, tg_login: `@p${i}` })) };
const reader: typeof validateGame = async () => ({ ok: true, plan: structuredClone(plan) });
const countGames = async () => Number((await db.query<{ n: number }>('select count(*) as n from games')).rows[0]!.n);
async function seedSchedule(id = '123', event = 'event') {
  return upsertScheduledGame({ source: 'MLBL', source_url: 'https://moscow.ilovebasket.ru', external_id: id,
    team: 'BLACK', team_a: 'Yandex Black', team_b: 'Opponent', game_date: '2026-10-20', game_time: '20:00',
    location: null, details_url: url.replace('/123', `/${id}`), calendar_event_id: event });
}
async function makeStable() {
  await checkAutomaticGameStats(11, 2026, now, reader);
  await checkAutomaticGameStats(11, 2026, later, reader);
}
function mockProtocol(seconds = 2400, date = '20.10.2026') {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    GameDate: date, GameTeams: ['Yandex Black', 'Opponent'].map((name) => ({
      TeamName: { CompTeamNameRu: name }, Players: Array.from({ length: 5 }, (_, i) => ({
        FirstNameRu: 'Имя', LastNameRu: ['Первый', 'Второй', 'Третий', 'Четвертый', 'Пятый'][i], Seconds: seconds,
      })),
    })),
  }), { status: 200 }));
}

before(async () => {
  mock.method(pool, 'query', sql);
  mock.method(pool, 'connect', async () => ({ query: sql, release() {} }));
  mock.method(calendar_v3.Resource$Events.prototype, 'list', async () => ({ data: { items: [] } }));
  await migrate();
});
beforeEach(async () => {
  await db.exec('truncate schedule_sources, game_stats_checks, scheduled_games, games, charges, budgets, players restart identity cascade');
  for (let i = 0; i < 5; i++) await db.query(
    "insert into players (name,tg_login,team,is_employee) values ($1,$2,'BLACK',true)",
    [`Имя ${['Первый', 'Второй', 'Третий', 'Четвертый', 'Пятый'][i]}`, `@p${i}`]);
});
after(async () => { mock.restoreAll(); await db.close(); await pool.end(); });

test('январский бюджет собирает декабрь предыдущего года', () => {
  assert.deepEqual(sourcePeriod(1, 2027), { from: '2026-12-01', to: '2027-01-01' });
});
test('автосопоставление не угадывает фамилию и не выбирает неоднозначное ФИО', () => {
  const p = { id: 1, name: 'Иван Петров' } as Player;
  assert.equal(matchPlayer('Сергей Петров', [p], true), undefined);
  assert.equal(matchPlayer('Петров', [p], true), undefined);
  assert.equal(matchPlayer('Петров Иван', [p], true)?.id, 1);
  assert.equal(matchPlayer('Петров Иван', [p, { ...p, id: 2 }], true), undefined);
});
test('порядок игроков не меняет отпечаток, состав и тариф меняют', () => {
  assert.equal(planFingerprint(plan), planFingerprint({ ...plan, participants: [...plan.participants].reverse() }));
  assert.notEqual(planFingerprint(plan), planFingerprint({ ...plan, fee: 999 }));
});
test('одна успешная проверка сразу готова к расчёту, сбой не использует старый результат', async () => {
  await seedSchedule();
  assert.equal((await checkAutomaticGameStats(11, 2026, now, reader))[0]!.ready, true);
  assert.equal((await checkAutomaticGameStats(11, 2026, new Date(now.getTime() + 1000), reader))[0]!.ready, true);
  assert.equal((await checkAutomaticGameStats(11, 2026, later, reader))[0]!.ready, true);
  const fail: typeof reader = async () => { throw new Error('Источник недоступен'); };
  assert.match((await checkAutomaticGameStats(11, 2026, later, fail))[0]!.error!, /недоступен/);
  assert.equal((await checkAutomaticGameStats(11, 2026, later, reader))[0]!.ready, true);
  const changed: typeof reader = async () => ({ ok: true, plan: { ...plan, fee: 900 } });
  assert.equal((await checkAutomaticGameStats(11, 2026, new Date(later.getTime() + 3600000), changed))[0]!.ready, true);
});
test('полный протокол импортируется один раз; повторная сборка не удваивает игры', async () => {
  await seedSchedule();
  mockProtocol();
  await importAutomaticGameStats(11, 2026, []);
  assert.equal(await countGames(), 1);
  await importAutomaticGameStats(11, 2026, []);
  assert.equal(await countGames(), 1);
  const g = (await db.query<{ fee_per_player: string; participants: unknown[] }>('select * from games')).rows[0]!;
  assert.equal(Number(g.fee_per_player) * g.participants.length, 5000);
});
test('некорректное время, другая дата, отсутствие источника и конфликт тренера блокируют начисления', async () => {
  const scheduled = await seedSchedule();
  mockProtocol(-1);
  assert.match((await checkAutomaticGameStats(11, 2026, now))[0]!.error!, /Некорректное время/);
  mockProtocol(2400, '21.10.2026');
  assert.match((await checkAutomaticGameStats(11, 2026, now))[0]!.error!, /Дата/);
  await db.query('update scheduled_games set coach_conflict=true where id=$1', [scheduled.id]);
  assert.match((await checkAutomaticGameStats(11, 2026, now, reader))[0]!.error!, /конфликт/);
  await db.query('update scheduled_games set present_in_source=false where id=$1', [scheduled.id]);
  assert.match((await checkAutomaticGameStats(11, 2026, now, reader))[0]!.error!, /исчез/);
  assert.equal(await countGames(), 0);
});
test('неизвестный календарный матч блокирует весь импорт; частичных записей нет', async () => {
  await seedSchedule(); mockProtocol();
  await checkAutomaticGameStats(11, 2026, now);
  await assert.rejects(importAutomaticGameStats(11, 2026, [{ uid: 'missing', team: 'RED', summary: 'Игра без протокола',
    start: '2026-10-15T19:00:00+03:00', startDateTime: true, location: null, tags: { TYPE: 'GAME' } }]), /[Нн]ет проверенного протокола/);
  assert.equal(await countGames(), 0);
});
test('в опубликованный период автоматический и ручной импорт запрещены', async () => {
  await seedSchedule(); await makeStable(); mockProtocol();
  await db.query("insert into budgets (team,month,year,message_id) values ('BLACK',11,2026,100)");
  await assert.rejects(importAutomaticGameStats(11, 2026, []), /Опубликованный/);
  await assert.rejects(registerValidatedGames([plan], 11, 2026), /Опубликованный/);
  assert.equal(await countGames(), 0);
});
test('один матч нельзя автоматически перенести из другого месяца, в том числе по другому URL', async () => {
  await seedSchedule(); await makeStable(); mockProtocol();
  await registerValidatedGames([{ ...plan, url: 'https://ilovebasket.ru/games/123#protocol' }], 10, 2026);
  await assert.rejects(importAutomaticGameStats(11, 2026, []), /другому бюджету/);
  await assert.rejects(registerValidatedGames([plan], 11, 2026), /другому месяцу/);
  assert.equal(await countGames(), 1);
});

test('ручной пакет с двумя вариантами одной ссылки откатывается целиком', async () => {
  await assert.rejects(registerValidatedGames([plan, { ...plan, url: 'https://ilovebasket.ru/games/123#protocol' }], 11, 2026), /несколько раз/);
  assert.equal(await countGames(), 0);
});

test('изменение протокола после автоматического импорта блокирует публикацию', async () => {
  await seedSchedule(); mockProtocol();
  await checkAutomaticGameStats(11, 2026, now);
  await importAutomaticGameStats(11, 2026, []);
  await db.query('update tariffs set coach_per_game=6000');
  try {
    await assert.rejects(importAutomaticGameStats(11, 2026, [], true), /протокол или тариф изменился/);
    assert.equal(await countGames(), 1);
    assert.equal(Number((await db.query<{ fee_per_player: string }>('select fee_per_player from games')).rows[0]!.fee_per_player), 1000);
    await importAutomaticGameStats(11,2026,[]);
    assert.equal(await countGames(),1);
    assert.equal(Number((await db.query<{ fee_per_player: string }>('select fee_per_player from games')).rows[0]!.fee_per_player),1200);
    await importAutomaticGameStats(11,2026,[],true);
  } finally { await db.query('update tariffs set coach_per_game=5000'); }
});


test('сборка учитывает кросс-командный взнос ровно один раз; перед отправкой сверяет сохранённые суммы', async () => {
  await seedSchedule(); mockProtocol();
  await checkAutomaticGameStats(11, 2026, now);
  await db.exec("update players set team='RED' where id=1");
  const built = await buildAndSaveBudgets(11, 2026);
  assert.equal(built.length, 2);
  const charges = (await db.query<{ player_id: number; game_amount: string }>('select player_id,game_amount from charges')).rows;
  assert.equal(charges.length, 5);
  assert.equal(charges.reduce((n, c) => n + Number(c.game_amount), 0), 5000);
  assert.equal(charges.filter((c) => c.player_id === 1).length, 1);
  await buildAndSaveBudgets(11, 2026);
  assert.equal(await countGames(), 1);
  await db.exec("update budgets set details=jsonb_set(details,'{correction,reviewed}','true')");
  const sent: unknown[] = [];
  const api = { sendMessage: async (...args: unknown[]) => { sent.push(args); return { message_id: 99 }; } } as never;
  const red = built.find((b) => b.team === 'RED')!;
  await db.query('update charges set game_amount=999 where budget_id=$1', [red.budgetId]);
  await assert.rejects(sendBudgetToChat(api, red.budgetId), /Начисления за игры изменились/);
  assert.equal(sent.length, 0);
  await db.query('update charges set game_amount=1000 where budget_id=$1', [red.budgetId]);
  await sendBudgetToChat(api, red.budgetId);
  assert.equal(sent.length, 1);
});

test('сыгравший, исключённый из следующего бюджета, останавливает сборку вместо недосбора', async () => {
  await seedSchedule(); mockProtocol();
  await checkAutomaticGameStats(11, 2026, now);
  await db.exec("update players set active_to='2026-10-31' where id=1");
  await assert.rejects(buildAndSaveBudgets(11, 2026), /участники не попадут в бюджет/);
  assert.equal(Number((await db.query<{ n: number }>('select count(*) as n from budgets')).rows[0]!.n), 0);
});


const calendarOnly = { uid: 'calendar-only', team: 'BLACK' as const, summary: 'Игра Yandex Black - Opponent',
  start: '2026-10-20T20:00:00+03:00', startDateTime: true, location: null, tags: { TYPE: 'GAME', COACH: 'PAID' } };
const manualOpts = { team: 'BLACK' as const, opponent: 'Opponent', date: '2026-10-20',
  logins: ['@p0','@p1','@p2','@p3','@p4'], coach: true, judge: false };

async function unavailableLeague() {
  await db.query("insert into schedule_sources (source,team,url,enabled) values ('MLBL','BLACK',$1,true)",
    ['https://moscow.ilovebasket.ru/schedule']);
  mock.method(globalThis,'fetch', async () => new Response('Maintenance',{ status: 503 }));
}

test('игра только в календаре без протокола блокирует сборку; ручная запись позволяет расчёт при недоступной лиге', async () => {
  await unavailableLeague();
  await assert.rejects(importAutomaticGameStats(11,2026,[calendarOnly]), /ручного расчёта/);
  assert.equal(await countGames(),0);
  const scheduled = (await db.query<{ id: string }>("select id from scheduled_games where source='CALENDAR'")).rows[0]!;
  await registerManualGame({ ...manualOpts, scheduledGameId: scheduled.id },11,2026);
  await importAutomaticGameStats(11,2026,[calendarOnly]);
  assert.equal(await countGames(),1);
  const game = (await db.query<{ month: number; event_uid: string }>('select month,event_uid from games')).rows[0]!;
  assert.equal(game.month,11);
  assert.equal(game.event_uid,calendarOnly.uid);
  await assert.rejects(registerManualGame({ ...manualOpts, scheduledGameId: scheduled.id },11,2026), /уже есть начисление/);
  await assert.rejects(importAutomaticGameStats(11,2026,[calendarOnly,
    { ...calendarOnly,uid:'missing-second',summary:'Игра Yandex Black - Second',start:'2026-10-21T20:00:00+03:00' }]), /ручного расчёта/);
  assert.equal(await countGames(),1);
});

test('после восстановления лиги протокол принимает календарную связь и не начисляется повторно', async () => {
  await unavailableLeague();
  await assert.rejects(importAutomaticGameStats(11,2026,[calendarOnly]));
  const scheduled = (await db.query<{ id: string }>("select id from scheduled_games where source='CALENDAR'")).rows[0]!;
  await registerManualGame({ ...manualOpts,scheduledGameId: scheduled.id },11,2026);
  mockProtocol();
  const protocolFetch = globalThis.fetch;
  mock.method(globalThis,'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/schedule') return new Response('window.comps = [{"id":1,"apiUrl":"https://reg.infobasket.su"}];');
    if (url.pathname.includes('GetCalendarCarousel')) return new Response(JSON.stringify([
      { GameID:123,GameDate:'20.10.2026',GameTime:'20:00',GameStatus:1,ShortTeamNameAru:'Yandex Black',ShortTeamNameBru:'Opponent' }
    ]));
    return protocolFetch(input,init);
  });
  await importAutomaticGameStats(11,2026,[calendarOnly]);
  assert.equal(await countGames(),1);
  const adopted = (await db.query<{ source: string; calendar_event_id: string; external_id: string }>(
    'select source,calendar_event_id,external_id from scheduled_games where id=$1',[scheduled.id])).rows[0]!;
  assert.equal(adopted.source,'MLBL');
  assert.equal(adopted.external_id,'123');
  assert.equal(adopted.calendar_event_id,calendarOnly.uid);
});

test('ручной состав с неизвестным игроком или повтором не создаёт частичного начисления', async () => {
  await assert.rejects(registerManualGame({ ...manualOpts,logins:['@p0','@absent'] },11,2026), /Не найдены игроки/);
  await assert.rejects(registerManualGame({ ...manualOpts,logins:['@p0','@p0'] },11,2026), /несколько раз/);
  assert.equal(await countGames(),0);
});


test('любое положительное время определяет участие независимо от суммы минут команды', async () => {
  await seedSchedule();
  for (const seconds of [1,1200,2400,3000]) {
    mockProtocol(seconds);
    const check = (await checkAutomaticGameStats(11,2026,now))[0]!;
    assert.equal(check.plan?.playedCount,5);
    assert.equal(check.plan?.fee,1000);
    assert.equal(check.error,null);
    assert.equal(check.ready,true);
  }
  mockProtocol(0);
  assert.equal((await checkAutomaticGameStats(11,2026,now))[0]!.plan,undefined);
});

test('декабрьский бюджет собирает базовую часть до ноябрьских матчей, но не публикует непроверенные взносы', async () => {
  const scheduled = await seedSchedule();
  await db.query("update scheduled_games set game_date='2026-11-01' where id=$1",[scheduled.id]);
  const built = await buildAndSaveBudgets(12,2026);
  assert.equal(built.length,1);
  assert.equal(built[0]!.team,'COMMON');
  assert.equal(await countGames(),0);
  const saved = (await db.query<{ details: { game_stats_warnings: string[] } }>('select details from budgets')).rows;
  // В зависимости от текущего дня матч бывает ещё не сыгран либо уже требует
  // сверки протокола; в обоих случаях публикация до пересборки запрещена.
  assert.ok(saved.every((b) => b.details.game_stats_warnings.length > 0));
  const charges = (await db.query<{ base_amount: string; game_amount: string; amount: string }>('select * from charges')).rows;
  assert.equal(charges.length,5);
  assert.ok(charges.every((c) => Number(c.base_amount)>0 && Number(c.game_amount)===0 && Number(c.amount)===Number(c.base_amount)));
  await db.exec("update budgets set details=jsonb_set(details,'{correction,reviewed}','true')");
  let sends = 0;
  const api = { sendMessage: async () => { sends++; return { message_id:99 }; } } as never;
  await assert.rejects(sendBudgetToChat(api,built[0]!.budgetId),/Статистика игр не готова/);
  assert.equal(sends,0);
});

test('после ручного заполнения состава пересборка добавляет взносы и снимает предупреждение', async () => {
  const scheduled = await upsertScheduledGame({ source:'CALENDAR',source_url:'https://calendar.google.com/',
    external_id:'BLACK:calendar-only',team:'BLACK',team_a:'Yandex Black',team_b:'Opponent',game_date:'2026-10-20',
    game_time:'20:00',location:null,details_url:null,calendar_event_id:'calendar-only' });
  await buildAndSaveBudgets(11,2026);
  const before = (await db.query<{ base_amount: string }>('select base_amount from charges order by id')).rows;
  assert.equal(await countGames(),0);
  await registerManualGame({ ...manualOpts,scheduledGameId:scheduled.id },11,2026);
  await buildAndSaveBudgets(11,2026);
  const saved = (await db.query<{ details: { game_stats_warnings: string[] } }>('select details from budgets')).rows;
  assert.ok(saved.every((b) => b.details.game_stats_warnings.length===0));
  const after = (await db.query<{ base_amount: string; game_amount: string }>('select base_amount,game_amount from charges order by id')).rows;
  assert.deepEqual(after.map((c) => c.base_amount),before.map((c) => c.base_amount));
  assert.equal(after.reduce((n,c)=>n+Number(c.game_amount),0),5000);
});
