import '../test/env.js';
import assert from 'node:assert/strict';
import { mock,test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrator.js';
import { calculateMonthlyPayoutPreview } from './monthlyPayout.service.js';

test('расчёты октября и ноября сортируют даты игр Date, строки и null без смены календарного дня', async () => {
  const db=new PGlite();
  const sql=async(text:string,params?:unknown[])=>{
    const result=params?await db.query(text,params):(await db.exec(text)).at(-1)!;
    for(const field of result.fields)if(field.dataTypeID===1700){
      for(const row of result.rows as Record<string,unknown>[])if(row[field.name]!==null)row[field.name]=Number(row[field.name]);
    }
    if(/from games/.test(text))for(const row of result.rows as Record<string,unknown>[]){
      // Воспроизводим стандартный pg-парсер SQL DATE, которого нет у PGlite.
      if(row.played_on){
        const date=row.played_on instanceof Date?row.played_on.toISOString().slice(0,10):String(row.played_on).slice(0,10);
        const [year,month,day]=date.split('-').map(Number);
        row.played_on=row.opponent==='Строковая дата'?date:new Date(year!,month!-1,day!);
      }
    }
    return result;
  };
  mock.method(pool,'query',sql);
  mock.method(pool,'connect',async()=>({query:sql,release(){}}));
  mock.method(calendar_v3.Resource$Events.prototype,'list',async(args:{calendarId:string;timeMin:string})=>({
    data:{items:args.calendarId==='test-red'?[{id:'training',summary:'Тренировка',
      description:'TYPE=TRAINING\nCOACH=PAID\nGYM=PAID',start:{dateTime:`${new Date(args.timeMin).getFullYear()}-${String(new Date(args.timeMin).getMonth()+1).padStart(2,'0')}-15T19:00:00+03:00`}}]:[]},
  }));
  try {
    await migrate();
    await db.exec(`insert into games(team,opponent,played_on,month,year,coach_present,participants) values
      ('RED','Дата Date','2026-10-04',10,2026,true,'[]'),
      ('BLACK','Строковая дата','2026-10-11',10,2026,true,'[]'),
      ('MIXED','Без даты',null,10,2026,true,'[]'),
      ('BLACK','Ноябрьская игра','2026-11-01',11,2026,true,'[]')`);
    const october=await calculateMonthlyPayoutPreview(10,2026);
    assert.deepEqual(october.coach_items.map((item)=>item.date),['2026-10-04','2026-10-11','2026-10-15T19:00:00+03:00',null]);
    assert.equal(october.coach_amount,20000);
    assert.equal(october.gym_amount,28500);
    const november=await calculateMonthlyPayoutPreview(11,2026);
    assert.equal(november.coach_items[0]!.date,'2026-11-01');
    assert.equal(november.coach_amount,10000);
    assert.ok(november.coach_items.every((item)=>item.date===null||typeof item.date==='string'));
  } finally { mock.restoreAll();await db.close();await pool.end(); }
});
