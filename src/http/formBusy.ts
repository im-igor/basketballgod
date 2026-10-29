/** Общая защита обычных HTML-форм. Срабатывает после валидации и подтверждения. */
export const FORM_BUSY_SCRIPT = `(function(){
  var busy=false, currentForm=null, states=[], hidden=null;
  function restore(){
    states.forEach(function(s){s.button.disabled=s.disabled;s.button.innerHTML=s.html;s.button.classList.remove('loading');s.button.removeAttribute('aria-busy')});
    if(currentForm)currentForm.removeAttribute('aria-busy');
    if(hidden)hidden.remove();
    busy=false;currentForm=null;states=[];hidden=null;
  }
  document.addEventListener('submit',function(event){
    if(event.defaultPrevented)return;
    if(busy){event.preventDefault();return}
    var form=event.target;
    if(!form||form.tagName!=='FORM'||form.method==='dialog')return;
    var button=event.submitter||form.querySelector('button:not([type="button"]):not([type="reset"]),input[type="submit"]');
    if(button&&button.name){hidden=document.createElement('input');hidden.type='hidden';hidden.name=button.name;hidden.value=button.value;form.appendChild(hidden)}
    busy=true;currentForm=form;form.setAttribute('aria-busy','true');
    document.querySelectorAll('form button,form input[type="submit"]').forEach(function(control){
      states.push({button:control,disabled:control.disabled,html:control.innerHTML});control.disabled=true;
    });
    if(button){button.classList.add('loading');button.setAttribute('aria-busy','true');
      if(button.tagName==='BUTTON')button.textContent=button.getAttribute('data-loading-label')||form.getAttribute('data-loading-label')||'Выполняется…';
    }
  });
  window.addEventListener('pageshow',restore);
})();`;
