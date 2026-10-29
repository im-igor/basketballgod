import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { FORM_BUSY_SCRIPT } from './formBusy.js';

function setup() {
  const listener: Record<string,(event: any)=>void> = {};
  function button(disabled=false) {
    const attrs:Record<string,string> = {};
    const classes = new Set<string>();
    return { tagName:'BUTTON',disabled,name:'action',value:'save',innerHTML:'Сохранить',
      get textContent(){return this.innerHTML},set textContent(value:string){this.innerHTML=value},
      classList:{add:(v:string)=>classes.add(v),remove:(v:string)=>classes.delete(v),contains:(v:string)=>classes.has(v)},
      getAttribute:(k:string)=>attrs[k]??null,setAttribute:(k:string,v:string)=>{attrs[k]=v},removeAttribute:(k:string)=>{delete attrs[k]} };
  }
  const submit = button(), disabled = button(true);
  const fields:any[] = [];
  const attrs:Record<string,string>={};
  const form = { tagName:'FORM',method:'post',querySelector:()=>submit,appendChild:(v:any)=>fields.push(v),
    getAttribute:(k:string)=>attrs[k]??null,setAttribute:(k:string,v:string)=>{attrs[k]=v},removeAttribute:(k:string)=>{delete attrs[k]} };
  const document = { addEventListener:(k:string,fn:any)=>{listener[k]=fn},querySelectorAll:()=>[submit,disabled],
    createElement:()=>({remove(){fields.splice(fields.indexOf(this),1)}}) };
  const window = { addEventListener:(k:string,fn:any)=>{listener[k]=fn} };
  runInNewContext(FORM_BUSY_SCRIPT,{document,window});
  const event = (prevented=false) => ({ target:form,submitter:submit,defaultPrevented:prevented,
    preventDefault(){this.defaultPrevented=true} });
  return {listener,submit,disabled,form,fields,event};
}

test('спиннер, блокировка повторной отправки и сохранение значения нажатой кнопки', () => {
  const s=setup();
  s.listener.submit!(s.event());
  assert.equal(s.submit.disabled,true);
  assert.equal(s.submit.classList.contains('loading'),true);
  assert.equal(s.submit.textContent,'Выполняется…');
  assert.equal(s.form.getAttribute('aria-busy'),'true');
  assert.equal(s.fields[0].name,'action');
  assert.equal(s.fields[0].value,'save');
  const repeat=s.event();s.listener.submit!(repeat);
  assert.equal(repeat.defaultPrevented,true);
  assert.equal(s.fields.length,1);
  s.listener.pageshow!({});
  assert.equal(s.submit.disabled,false);
  assert.equal(s.disabled.disabled,true);
  assert.equal(s.submit.textContent,'Сохранить');
  assert.equal(s.fields.length,0);
  assert.equal(s.form.getAttribute('aria-busy'),null);
});

test('отмена подтверждения не блокирует кнопки; специальный текст загрузки сохраняется', () => {
  const s=setup();
  s.listener.submit!(s.event(true));
  assert.equal(s.submit.disabled,false);
  assert.equal(s.fields.length,0);
  s.form.setAttribute('data-loading-label','Собираю бюджет…');
  s.listener.submit!(s.event());
  assert.equal(s.submit.textContent,'Собираю бюджет…');
});
