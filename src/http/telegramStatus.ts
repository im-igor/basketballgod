export const TELEGRAM_STATUS_STYLE = `
.header-actions { --header-control-width:118px; }
.nav-menu > summary { width:var(--header-control-width); display:flex; align-items:center; justify-content:center; }
.telegram-status { width:var(--header-control-width); min-height:0; padding:8px 11px; display:flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--field-line); border-radius:8px; background:var(--card); color:var(--muted); font-weight:650; line-height:1.5; box-shadow:none; white-space:nowrap; }
.telegram-status:hover { background:var(--hover); border-color:var(--muted); color:var(--fg); }
.telegram-status[data-state="available"] { background:var(--ok-soft); border-color:var(--ok); color:var(--ok); }
.telegram-status[data-state="unavailable"] { background:var(--danger-soft); border-color:var(--danger); color:var(--danger); }
.telegram-status-dot { width:8px; height:8px; flex:none; border-radius:50%; background:#f59e0b; }
[data-state="available"] > .telegram-status-dot { background:var(--ok); }
[data-state="unavailable"] > .telegram-status-dot { background:var(--danger); }
@media(max-width:600px) {
  .header-actions { --header-control-width:42px; }
  .telegram-status-label { display:none; }
}
`;

export const TELEGRAM_STATUS_HTML = `<button id="telegram-status" class="telegram-status" type="button" data-state="unknown" aria-live="polite" aria-label="Telegram API: статус не проверен" title="Проверить доступность Telegram API">
  <span class="telegram-status-dot" aria-hidden="true"></span>
  <span class="telegram-status-label">Telegram</span>
</button>`;

export const TELEGRAM_STATUS_SCRIPT = `
(function () {
  var indicator = document.getElementById('telegram-status');
  if (!indicator) return;
  var pending = false;
  function render(state, text) {
    indicator.dataset.state = state;
    indicator.setAttribute('aria-label', 'Telegram API: ' + text);
    indicator.title = text + ' Нажмите, чтобы проверить ещё раз.';
  }
  async function check(force) {
    if (pending) return;
    pending = true;
    indicator.setAttribute('aria-busy', 'true');
    render('unknown', 'проверяем соединение…');
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var url = '/api/telegram-status' + (force ? '?refresh=1' : '');
      var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('Status unavailable');
      var status = await response.json();
      if (typeof status.available !== 'boolean' || !Number.isFinite(Date.parse(status.checkedAt)) || !Number.isFinite(status.latencyMs)) throw new Error('Invalid status');
      var checked = new Date(status.checkedAt).toLocaleTimeString('ru-RU');
      render(status.available ? 'available' : 'unavailable',
        (status.available ? 'доступен, ответ за ' + status.latencyMs + ' мс.' : 'недоступен.') + ' Проверено в ' + checked + '.');
    } catch (_) {
      render('unknown', 'статус неизвестен.');
    } finally {
      clearTimeout(timeout);
      pending = false;
      indicator.removeAttribute('aria-busy');
    }
  }
  indicator.addEventListener('click', function () { check(true); });
  check(false);
})();
`;
