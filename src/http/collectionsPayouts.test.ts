import '../test/env.js';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { mock,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import type { Bot } from 'grammy';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { buildServer } from './server.js';
import { monthLabel } from '../domain/dates.js';
import { sendBudgetToChat } from '../services/notify.service.js';

test('Расчеты: суммы видны, детали свернуты, календарь не блокирует список и черновики защищены', async () => {
  const db=new PGlite();
  const sql=async(text:string,params?:unknown[])=>params?db.query(text,params):(await db.exec(text)).at(-1)!;
  let queryCalls=0;
  mock.method(pool,'query',async(text:string,params?:unknown[])=>{queryCalls++;return sql(text,params)});
  // PGlite uses one session; emulate separate sessions for the HTTP build lock.
  let buildLocked=false;
  mock.method(pool,'connect',async()=>({query:async(text:string,params?:unknown[])=>{
    if(text==='select pg_try_advisory_lock(3802027) as locked') {
      if(buildLocked)return {rows:[{locked:false}]};
      buildLocked=true;return {rows:[{locked:true}]};
    }
    if(text==='select pg_advisory_unlock(3802027)') {buildLocked=false;return {rows:[]};}
    return sql(text,params);
  },release(){}}));
  let unavailable=false;
  let calendarCalls=0;
  let calendarGate:Promise<void>|undefined;
  let calendarStarted:(()=>void)|undefined;
  mock.method(calendar_v3.Resource$Events.prototype,'list',async(args:{ calendarId:string })=>{
    calendarCalls++;
    calendarStarted?.();
    if(calendarGate)await calendarGate;
    if(unavailable)throw new Error('Календарь временно недоступен');
    return {data:{items:args.calendarId==='test-red' ? [
      {id:'paid',summary:'Тренировка RED',description:'TYPE=TRAINING\nCOACH=PAID\nGYM=PAID',start:{dateTime:'2026-11-05T19:00:00+03:00'}},
      {id:'free',summary:'Без тренера',description:'TYPE=TRAINING\nCOACH=FREE\nGYM=FREE',start:{dateTime:'2026-11-12T19:00:00+03:00'}},
    ]:[]}};
  });
  let app:Awaited<ReturnType<typeof buildServer>>|undefined;
  try {
    await migrate();
    await db.exec("insert into budgets(team,month,year) values ('RED',10,2026),('RED',11,2026); update budgets set message_id=101 where month=10");
    await db.query(`insert into monthly_payouts(month,year,coach_amount,gym_amount,coach_training_sessions,coach_games,
      paid_gym_sessions,coach_per_session,coach_per_game,gym_paid_price,locker_rent_price,coach_items,gym_items)
      values(10,2026,12345,67890,1,0,1,5000,5000,25500,3000,$1,$2)`,[
      JSON.stringify([{kind:'TRAINING',date:'2026-10-15',label:'Октябрьская тренировка',amount:12345,team:'RED'}]),
      JSON.stringify([{kind:'GYM',date:'2026-10-15',label:'Октябрьский зал',amount:67890}]),
    ]);
    app=await buildServer({api:{}} as Bot);
    const login=await app.inject({method:'POST',url:'/login',payload:{username:'test',password:'test-password'}});
    const cookies={bbg_auth:login.cookies[0]!.value};
    queryCalls=0;
    const page=await app.inject({method:'GET',url:'/collections',cookies});
    assert.equal(page.statusCode,200);
    assert.match(page.body,/<h1>Расчеты<\/h1>/);
    assert.equal(calendarCalls,0);
    assert.equal(queryCalls,3);
    assert.doesNotMatch(page.body,/<details[^>]* open/);
    assert.match(page.body,/Начислено тренеру: 12345 ₽/);
    assert.match(page.body,/Начислено за зал: 67890 ₽/);
    assert.doesNotMatch(page.body,/Начислено тренеру: 5000 ₽/);
    assert.match(page.body,/data-payout-auto data-payout-url="\/collections\/11-2026\/payout\?card=1"/);
    const preview=await app.inject({method:'GET',url:'/collections/11-2026/payout?card=1',cookies});
    assert.equal(preview.statusCode,200);
    assert.equal(calendarCalls,2);
    assert.match(preview.body,/Начислено тренеру — 5000₽/);
    assert.match(preview.body,/Начислено за зал — 28500₽/);
    assert.match(preview.body,/Предварительно по текущему календарю/);
    assert.equal(preview.headers['cache-control'],'no-store');
    const panel = parse(preview.body);
    assert.ok(panel.querySelector('.settlement-payout-values'));
    assert.equal(panel.querySelector('.settlement-details')!.hasAttribute('open'), false);
    assert.equal(panel.querySelector('.settlement-details .settlement-payout-values'), null);
    assert.match(panel.querySelector('.settlement-details summary')!.textContent, /Расшифровка начислений/);
    const savedPanel = parse(page.body).querySelector('.settlement-card--partial .settlement-payouts')!;
    assert.ok(savedPanel.querySelector('.settlement-payout-values'));
    assert.equal(savedPanel.querySelector('.settlement-details .settlement-payout-values'), null);
    assert.match(page.body,/Итоговый расчёт/);
    assert.match(page.body,/Октябрьская тренировка/);
    assert.match(page.body,/Октябрьский зал/);
    assert.match(page.body,/Расчёты с тренером и залом/);
    assert.match(page.body,/settlement-card--draft/);
    assert.match(page.body,/settlement-payout-values/);
    assert.match(page.body,/role="progressbar"/);
    assert.doesNotMatch(page.body,/href="\/payouts/);
    assert.equal((await db.query('select * from monthly_payouts where month=11')).rows.length,0);
    unavailable=true;
    const failed=await app.inject({method:'GET',url:'/collections',cookies});
    assert.equal(failed.statusCode,200);
    assert.match(failed.body,/Начислено тренеру: 12345 ₽/);
    assert.equal(calendarCalls,2);
    const detail=await app.inject({method:'GET',url:'/collections/11-2026',cookies});
    assert.equal(detail.statusCode,200);
    assert.equal(calendarCalls,2);
    assert.match(detail.body,/<details class="card" id="payouts" data-payout-url=/);
    const failedPreview=await app.inject({method:'GET',url:'/collections/11-2026/payout',cookies});
    assert.equal(failedPreview.statusCode,503);
    assert.match(failedPreview.body,/Календарь временно недоступен/);
    const saved=await app.inject({method:'GET',url:'/collections/10-2026/payout',cookies});
    assert.equal(saved.statusCode,200);
    assert.match(saved.body,/12345₽/);
    const picker=await app.inject({method:'GET',url:'/budgets/new?year=2026',cookies});
    assert.match(picker.body,/<button disabled aria-label="[^"]+уже есть бюджет/);
    assert.doesNotMatch(picker.body,/href="\/budgets\?mode=create&month=(10|11)&year=2026"/);
    assert.match(picker.body,/href="\/budgets\?mode=create&month=12&year=2026"/);
    const draftCard=page.body.match(/<section[^>]*aria-label="Расчеты за [^"]+">[\s\S]*?<\/section>/)?.[0];
    assert.ok(draftCard);
    assert.match(draftCard,/Редактировать/);
    assert.doesNotMatch(draftCard,/Оплаты игроков/);
    assert.match(draftCard,/action="\/collections\/11-2026\/delete"/);
    const publishedCard=page.body.match(/<section class="settlement-card settlement-card--partial"[\s\S]*?<\/section>/)?.[0];
    assert.ok(publishedCard);
    assert.doesNotMatch(publishedCard,/Редактировать|>Удалить</);
    const post=async(mode:string,month:string)=>app!.inject({method:'POST',url:'/budgets/build',cookies,payload:{mode,month,year:'2026'}});
    const duplicate=await post('create','11');
    assert.match(decodeURIComponent(duplicate.headers.location!),/уже есть бюджет/);
    const publishedEdit=await post('edit','10');
    assert.match(decodeURIComponent(publishedEdit.headers.location!),/Опубликованный бюджет нельзя редактировать/);
    const missingEdit=await post('edit','12');
    assert.match(decodeURIComponent(missingEdit.headers.location!),/Черновик не найден/);
    const invalid=await post('create','1.5');
    assert.match(decodeURIComponent(invalid.headers.location!),/Неверный месяц/);
    const createOccupied=await app.inject({method:'GET',url:'/budgets?mode=create&month=11&year=2026',cookies});
    assert.equal(createOccupied.statusCode,302);
    const editPublished=await app.inject({method:'GET',url:'/budgets?mode=edit&month=10&year=2026',cookies});
    assert.equal(editPublished.statusCode,302);
    const edit=await app.inject({method:'GET',url:'/budgets?mode=edit&month=11&year=2026',cookies});
    assert.equal(edit.statusCode,200);
    assert.match(edit.body,/name="mode" value="edit"/);
    assert.match(edit.body,/type="hidden" name="month" value="11"/);
    assert.doesNotMatch(edit.body,/name="month" type="number"/);
    unavailable=false;
    await db.exec("insert into players(name,tg_login,team,is_employee) values ('Тест RED','@test-red','RED',true),('Тест BLACK','@test-black','BLACK',true)");
    let releaseCalendar!:()=>void;
    calendarGate=new Promise<void>(resolve=>{releaseCalendar=resolve});
    const started=new Promise<void>(resolve=>{calendarStarted=resolve});
    const creating=post('create','12');
    await started;
    const concurrent=await post('create','12');
    assert.match(decodeURIComponent(concurrent.headers.location!),/Уже выполняется операция/);
    releaseCalendar();
    const created=await creating;
    assert.match(decodeURIComponent(created.headers.location!),/собраны для обеих команд/);
    calendarGate=undefined;calendarStarted=undefined;
    const createdBudgets=(await db.query<{id:number}>('select id from budgets where month=12 and year=2026')).rows;
    assert.equal(createdBudgets.length,2);
    const duplicateAfter=await post('create','12');
    assert.match(decodeURIComponent(duplicateAfter.headers.location!),/уже есть бюджет/);
    await db.exec('update charges set paid=true where budget_id in (select id from budgets where month=12)');
    const beforeEdit=await db.query('select id,paid from charges where budget_id in (select id from budgets where month=12) order by id');
    const rebuilt=await post('edit','12');
    assert.match(decodeURIComponent(rebuilt.headers.location!),/собраны для обеих команд/);
    assert.deepEqual((await db.query('select id,paid from charges where budget_id in (select id from budgets where month=12) order by id')).rows,beforeEdit.rows);
    assert.equal(buildLocked,false);
    // Payment actions preserve the selected filter; paid players stay hidden by default.
    const chargeId = (beforeEdit.rows[0] as {id:number}).id;
    const payment = (value:string, all?:string) => app!.inject({method:'POST',url:`/charges/${chargeId}/pay`,cookies,payload:{value,...(all ? {all} : {})}});
    const hidden = parse((await app.inject({method:'GET',url:'/collections/12-2026',cookies})).body);
    assert.equal(hidden.querySelector(`#charge-${chargeId}`),null);
    assert.ok(hidden.querySelector('input[role="switch"]')?.hasAttribute('checked'));
    const allPlayers = parse((await app.inject({method:'GET',url:'/collections/12-2026?all=1',cookies})).body);
    assert.equal(allPlayers.querySelector('input[role="switch"]')?.hasAttribute('checked'),false);
    assert.equal(allPlayers.querySelector(`#charge-${chargeId} input[name="all"]`)?.getAttribute('value'),'1');
    const paidDefault = await payment('yes');
    assert.doesNotMatch(paidDefault.headers.location!,/all=1|#charge-/);
    const paidFiltered = await payment('yes','0');
    const afterPaid = parse((await app.inject({method:'GET',url:paidFiltered.headers.location!,cookies})).body);
    assert.equal(afterPaid.querySelector(`#charge-${chargeId}`),null);
    assert.ok(afterPaid.querySelector('input[role="switch"]')?.hasAttribute('checked'));
    assert.match((await payment('yes','1')).headers.location!,/all=1/);
    assert.match((await payment('no','1')).headers.location!,/all=1/);
    const unpaid = parse((await app.inject({method:'GET',url:'/collections/12-2026',cookies})).body);
    assert.ok(unpaid.querySelector(`#charge-${chargeId}`));
    assert.equal(unpaid.querySelector(`#charge-${chargeId} input[name="all"]`)?.getAttribute('value'),'0');

    const remove=(month:number,confirmation=monthLabel(month,2026))=>app!.inject({method:'POST',url:`/collections/${String(month).padStart(2,'0')}-2026/delete`,cookies,payload:{confirmation}});
    const unconfirmed=await remove(12,'');
    assert.match(decodeURIComponent(unconfirmed.headers.location!),/Подтверди удаление/);
    const protectedMonth=await remove(10);
    assert.match(decodeURIComponent(protectedMonth.headers.location!),/Опубликованный бюджет нельзя удалить/);
    assert.equal((await db.query('select id from budgets where month=10')).rows.length,1);
    const fee=(await db.query<{id:number}>("insert into extra_fees(title,amount_per_player,team,mode,league,start_period) values ('Тест',250,'BOTH','BUDGET','ANY',202612) returning id")).rows[0]!;
    await db.query(`insert into extra_fee_allocations(fee_id,player_id,budget_id,tg_login,title,amount)
      select $1,player_id,budget_id,tg_login,'Тест',250 from charges where budget_id=$2 limit 1`,[fee.id,createdBudgets[0]!.id]);
    assert.equal((await db.query('select id from extra_fee_allocations')).rows.length,1);
    assert.ok(beforeEdit.rows.length>0);
    // Publishing holds the same operation lock while Telegram is responding.
    const publishBudget=(await db.query<{id:number}>("insert into budgets(team,month,year,details) values('RED',9,2026,$1) returning id",[JSON.stringify({total_players:2,players_team:1,players_other:1,paid_gym_sessions:0,coach_sessions:0,gym_per_person:0,coach_per_person:0,base_per_person:0})])).rows[0]!;
    let releaseSend!:()=>void;
    const sendGate=new Promise<void>(resolve=>{releaseSend=resolve});
    let sendStarted!:()=>void;
    const sendingStarted=new Promise<void>(resolve=>{sendStarted=resolve});
    const publishing=sendBudgetToChat({sendMessage:async()=>{sendStarted();await sendGate;return {message_id:555}}} as never,publishBudget.id);
    await sendingStarted;
    const duringPublish=await remove(9);
    assert.match(decodeURIComponent(duringPublish.headers.location!),/Уже выполняется операция/);
    releaseSend();await publishing;
    assert.match(decodeURIComponent((await remove(9)).headers.location!),/Опубликованный бюджет нельзя удалить/);
    const deleted=await remove(12);
    assert.match(decodeURIComponent(deleted.headers.location!),/удалён со всеми начислениями/);
    assert.equal((await db.query('select id from budgets where month=12')).rows.length,0);
    assert.equal((await db.query('select id from charges where budget_id=any($1::int[])',[createdBudgets.map(b=>b.id)])).rows.length,0);
    assert.equal((await db.query('select id from extra_fee_allocations')).rows.length,0);
    assert.equal((await db.query('select id from extra_fees where id=$1',[fee.id])).rows.length,1);
    assert.equal((await db.query('select id from players')).rows.length,2);
    const available=await app.inject({method:'GET',url:'/budgets/new?year=2026',cookies});
    assert.match(available.body,/href="\/budgets\?mode=create&month=12&year=2026"/);
    assert.match(decodeURIComponent((await remove(12)).headers.location!),/уже удалён/);


  } finally { await app?.close();mock.restoreAll();await db.close();await pool.end(); }
});
