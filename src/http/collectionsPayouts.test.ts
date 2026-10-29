import '../test/env.js';
import assert from 'node:assert/strict';
import { mock,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import type { Bot } from 'grammy';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { buildServer } from './server.js';

test('Расчеты показывают итоговые и предварительные начисления на карточках месяцев с расшифровкой', async () => {
  const db=new PGlite();
  const sql=async(text:string,params?:unknown[])=>params?db.query(text,params):(await db.exec(text)).at(-1)!;
  mock.method(pool,'query',sql);
  mock.method(pool,'connect',async()=>({query:sql,release(){}}));
  let unavailable=false;
  mock.method(calendar_v3.Resource$Events.prototype,'list',async(args:{ calendarId:string })=>{
    if(unavailable)throw new Error('Календарь временно недоступен');
    return {data:{items:args.calendarId==='test-red' ? [
      {id:'paid',summary:'Тренировка RED',description:'TYPE=TRAINING\nCOACH=PAID\nGYM=PAID',start:{dateTime:'2026-11-05T19:00:00+03:00'}},
      {id:'free',summary:'Без тренера',description:'TYPE=TRAINING\nCOACH=FREE\nGYM=FREE',start:{dateTime:'2026-11-12T19:00:00+03:00'}},
    ]:[]}};
  });
  let app:Awaited<ReturnType<typeof buildServer>>|undefined;
  try {
    await migrate();
    await db.exec("insert into budgets(team,month,year) values ('RED',10,2026),('RED',11,2026)");
    await db.query(`insert into monthly_payouts(month,year,coach_amount,gym_amount,coach_training_sessions,coach_games,
      paid_gym_sessions,coach_per_session,coach_per_game,gym_paid_price,locker_rent_price,coach_items,gym_items)
      values(10,2026,12345,67890,1,0,1,5000,5000,25500,3000,$1,$2)`,[
      JSON.stringify([{kind:'TRAINING',date:'2026-10-15',label:'Октябрьская тренировка',amount:12345,team:'RED'}]),
      JSON.stringify([{kind:'GYM',date:'2026-10-15',label:'Октябрьский зал',amount:67890}]),
    ]);
    app=await buildServer({api:{}} as Bot);
    const login=await app.inject({method:'POST',url:'/login',payload:{username:'test',password:'test-password'}});
    const cookies={bbg_auth:login.cookies[0]!.value};
    const page=await app.inject({method:'GET',url:'/collections',cookies});
    assert.equal(page.statusCode,200);
    assert.match(page.body,/<h1>Расчеты<\/h1>/);
    assert.match(page.body,/Начислено тренеру: 12345 ₽/);
    assert.match(page.body,/Начислено за зал: 67890 ₽/);
    assert.match(page.body,/Начислено тренеру: 5000 ₽/);
    assert.match(page.body,/Начислено за зал: 28500 ₽/);
    assert.match(page.body,/Предварительно по текущему календарю/);
    assert.match(page.body,/Итоговый расчёт/);
    assert.match(page.body,/Октябрьская тренировка/);
    assert.match(page.body,/Октябрьский зал/);
    assert.match(page.body,/Расшифровка начислений/);
    assert.match(page.body,/settlement-card--draft/);
    assert.match(page.body,/settlement-payout-values/);
    assert.match(page.body,/role="progressbar"/);
    assert.doesNotMatch(page.body,/href="\/payouts/);
    assert.equal((await db.query('select * from monthly_payouts where month=11')).rows.length,0);
    unavailable=true;
    const failed=await app.inject({method:'GET',url:'/collections',cookies});
    assert.equal(failed.statusCode,200);
    assert.match(failed.body,/Начислено тренеру: 12345 ₽/);
    assert.match(failed.body,/Не удалось рассчитать начисления/);
    assert.match(failed.body,/Календарь временно недоступен/);
  } finally { await app?.close();mock.restoreAll();await db.close();await pool.end(); }
});
