export const TELEGRAM_STATUS_STYLE = `
.telegram-status { max-width:1120px; margin:16px auto 0; padding:12px 18px; display:flex; align-items:center; gap:12px; border:2px solid #f59e0b; border-radius:12px; background:#fef3c7; color:#78350f; box-shadow:0 3px 14px #f59e0b26; }
.telegram-status[data-state="available"] { background:#dcfce7; border-color:#22c55e; color:#14532d; box-shadow:0 3px 14px #22c55e30; }
.telegram-status[data-state="unavailable"] { background:#fee2e2; border-color:#ef4444; color:#7f1d1d; box-shadow:0 3px 14px #ef444430; }
.telegram-status-dot { width:12px; height:12px; flex:none; border-radius:50%; background:#f59e0b; box-shadow:0 0 0 5px #f59e0b26; }
[data-state="available"] > .telegram-status-dot { background:#16a34a; box-shadow:0 0 0 5px #22c55e30; }
[data-state="unavailable"] > .telegram-status-dot { background:#dc2626; box-shadow:0 0 0 5px #ef444430; }
.telegram-status strong { display:block; font-size:14px; }
.telegram-status small { display:block; font-size:12px; margin-top:2px; }
@media(max-width:1168px) { .telegram-status { margin:16px 24px 0; } }
@media(max-width:600px) { .telegram-status { margin:12px 12px 0; padding:10px 14px; } }
`;

export const TELEGRAM_STATUS_HTML = `<div id="telegram-status" class="telegram-status" data-state="unknown" role="status" aria-live="polite" aria-atomic="true">
  <span class="telegram-status-dot" aria-hidden="true"></span>
  <div><strong data-telegram-title>Telegram API · статус не проверен</strong><small data-telegram-detail>Для автоматической проверки нужен JavaScript.</small></div>
</div>`;

export const TELEGRAM_STATUS_SCRIPT = `
(function () {
  var indicator = document.getElementById('telegram-status');
  if (!indicator) return;
  var title = indicator.querySelector('[data-telegram-title]');
  var detail = indicator.querySelector('[data-telegram-detail]');
  var pending = false;
  var timer;
  function render(state, label, text) {
    indicator.dataset.state = state;
    title.textContent = 'Telegram API · ' + label;
    detail.textContent = text;
  }
  async function check() {
    clearTimeout(timer);
    if (pending || document.hidden) return;
    pending = true;
    render('unknown', 'проверка…', 'Проверяем соединение сервера с Telegram.');
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch('/api/telegram-status', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('Status unavailable');
      var status = await response.json();
      if (typeof status.available !== 'boolean' || !Number.isFinite(Date.parse(status.checkedAt)) || !Number.isFinite(status.latencyMs)) throw new Error('Invalid status');
      var checked = new Date(status.checkedAt).toLocaleTimeString('ru-RU');
      render(status.available ? 'available' : 'unavailable', status.available ? 'доступен' : 'недоступен',
        (status.available ? 'Ответ за ' + status.latencyMs + ' мс.' : 'Сервер не получил успешный ответ от Telegram.') + ' Проверено в ' + checked + ' · обновление каждые 30 с.');
    } catch (_) {
      render('unknown', 'статус неизвестен', 'Не удалось получить статус. Повторная проверка через 30 с.');
    } finally {
      clearTimeout(timeout);
      pending = false;
      timer = setTimeout(check, 30000);
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      clearTimeout(timer);
      render('unknown', 'проверка приостановлена', 'Статус обновится при возвращении на страницу.');
    } else { check(); }
  });
  check();
})();
`;
