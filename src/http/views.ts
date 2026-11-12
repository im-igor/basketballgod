import { FORM_BUSY_SCRIPT } from './formBusy.js';
import { TELEGRAM_STATUS_HTML, TELEGRAM_STATUS_SCRIPT, TELEGRAM_STATUS_STYLE } from './telegramStatus.js';
/** SSR-вьюхи админ-панели: адаптивная вёрстка без фронтенд-фреймворков. */

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
.settlement-card { --settlement-border:#c6ccd5; --settlement-panel:#f2f5f9; border:2px solid var(--settlement-border); border-left:5px solid var(--ok); border-radius:16px; background:var(--card); overflow:hidden; margin:24px 0; box-shadow:0 6px 18px rgba(0,0,0,.07); }
html[data-theme="dark"] .settlement-card { --settlement-border:#4b5361; --settlement-panel:#242a34; box-shadow:0 8px 24px rgba(0,0,0,.28); }
.settlement-card--draft { border-left-color:var(--accent); }
.settlement-card--partial { border-left-color:var(--danger); }
.settlement-header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:18px 24px; border-bottom:1px solid var(--settlement-border); }
.settlement-title { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.settlement-title h2 { margin:0; font-size:22px; letter-spacing:-.03em; }
.settlement-title h2 a { color:var(--fg); }
.settlement-open { font-weight:650; white-space:nowrap; }
.settlement-body { display:grid; grid-template-columns:1.15fr 1fr; grid-template-rows:auto auto; }
.settlement-collection { padding:22px 24px; display:grid; grid-column:1; grid-row:1 / span 2; grid-template-rows:subgrid; }
.settlement-collection-footer { margin-top:16px; padding-top:12px; border-top:1px solid var(--settlement-border); font-size:13px; }
.settlement-section-label,.settlement-payout-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:13px; font-weight:650; color:var(--muted); }
.settlement-section-label>span { color:var(--ok); font-size:17px; }
.settlement-collected { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:10px 0 12px; }
.settlement-collected strong { font-size:28px; font-variant-numeric:tabular-nums; letter-spacing:-.04em; }
.settlement-collected>span { color:var(--muted); }
.settlement-percent { color:var(--ok); font-size:17px; margin-left:auto; }
.settlement-progress { height:8px; background:var(--track); border-radius:8px; overflow:hidden; }
.settlement-progress>span { display:block; height:100%; background:var(--ok); border-radius:8px; }
.settlement-counts { display:flex; flex-wrap:wrap; gap:16px; margin-top:12px; color:var(--muted); font-size:13px; }
.settlement-counts b { color:var(--fg); }
.settlement-debt { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-top:20px; font-size:12px; color:var(--muted); }
.settlement-debt b { color:var(--fg); white-space:nowrap; }
.settlement-debt button { font-size:12px; min-height:34px; padding:6px 10px; }
.settlement-payouts { display:grid; grid-column:2; grid-row:1 / span 2; grid-template-rows:subgrid; padding:22px 24px; background:var(--settlement-panel); border-left:1px solid var(--settlement-border); }
.settlement-estimate { border:1px solid var(--settlement-border); border-radius:6px; padding:2px 7px; font-size:11px; font-weight:500; }
.settlement-payout-values { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px; }
.settlement-metric { display:flex; flex-direction:column; gap:6px; padding:12px; background:var(--card); border:1px solid var(--settlement-border); border-radius:10px; min-width:0; }
.settlement-metric>span { color:var(--muted); font-size:12px; }
.settlement-metric strong { font-size:24px; font-variant-numeric:tabular-nums; letter-spacing:-.035em; overflow-wrap:anywhere; }
.settlement-updated { margin-top:12px; font-size:11px; color:var(--muted); }
.settlement-payout-load { display:contents; }
.settlement-details { margin-top:16px; padding-top:12px; border-top:1px solid var(--settlement-border); }
.settlement-details>summary { cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding:0; font-size:14px; font-weight:650; color:var(--link); list-style:none; }
.settlement-details>summary::-webkit-details-marker { display:none; }
.settlement-details[open]>summary>span { transform:rotate(180deg); }
.settlement-details [data-payout-content]>.card { margin:12px 0 0; padding:14px 0 0; background:transparent; border:0; border-top:1px solid var(--settlement-border); border-radius:0; box-shadow:none; }
.settlement-details .row { display:block; }
.settlement-details .row>div { min-width:0!important; width:100%; margin-bottom:16px; }
.settlement-details table { table-layout:fixed; font-size:12px; }
.settlement-details th:first-child,.settlement-details td:first-child { width:82px; }
.settlement-details th:last-child,.settlement-details td:last-child { width:85px; }
.settlement-details h2 { font-size:16px; }
.settlement-error { display:flex; flex-direction:column; gap:8px; color:var(--danger); font-size:13px; }
.settlement-error>span { color:var(--muted); }
.settlement-error details { font-size:12px; }
.settlement-error details p { overflow-wrap:anywhere; }
@media(max-width:760px) {
 .settlement-header { padding:16px; align-items:flex-start; }
 .settlement-title { gap:8px; }
 .settlement-title h2 { font-size:20px; }
 .settlement-open { font-size:12px; }
 .settlement-body { display:block; }
 .settlement-collection,.settlement-payouts { display:block; padding:18px 16px; }
 .settlement-payouts { border-left:0; border-top:1px solid var(--settlement-border); }
 .settlement-collected strong { font-size:26px; }
 .settlement-metric strong { font-size:22px; }
 .settlement-details>summary { padding:12px 0 0; }
}

:root {
  --bg:#f6f7f9; --card:#fff; --fg:#191c20; --muted:#69707d;
  --accent:#e85d2a; --accent-hover:#cf4c1d; --accent-soft:#fff0ea;
  --ok:#168a53; --ok-hover:#107442; --ok-soft:#e9f7ef; --danger:#c83b3b; --danger-soft:#fcecec;
  --line:#e4e7eb; --field:#fbfcfd; --field-line:#d8dce2; --hover:#f1f3f5;
  --row-hover:#fafbfc; --track:#eceff2; --header:rgba(255,255,255,.94);
  --link:#b8431c; --ghost-fg:#3f4650; --flash-line:#bce6cf; --flash-fg:#126b41;
  --shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px rgba(16,24,40,.05);
}
html[data-theme="dark"] {
  --bg:#111318; --card:#1a1d23; --fg:#edf0f4; --muted:#9ba3af;
  --accent:#ff7747; --accent-hover:#ff8b62; --accent-soft:#382219;
  --ok:#4bc486; --ok-hover:#5bd394; --ok-soft:#172d23; --danger:#ff7777; --danger-soft:#351e21;
  --line:#2b3039; --field:#15181e; --field-line:#373d48; --hover:#252932;
  --row-hover:#20242b; --track:#292e36; --header:rgba(26,29,35,.94);
  --link:#ff8b62; --ghost-fg:#d8dde5; --flash-line:#285b42; --flash-fg:#81dbae;
  --shadow:0 10px 30px rgba(0,0,0,.16);
}
* { box-sizing:border-box; }
html { color-scheme:light; }
html[data-theme="dark"] { color-scheme:dark; }
body { margin:0; background:var(--bg); color:var(--fg); font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:14px; line-height:1.5; }
a { color:var(--link); text-decoration:none; }
a:hover { color:var(--accent); }
header { background:var(--header); border-bottom:1px solid var(--line); padding:0 24px; min-height:64px; display:flex; gap:28px; align-items:center; position:sticky; top:0; z-index:10; backdrop-filter:blur(12px); }
.brand { color:var(--fg); text-decoration:none; font-size:16px; font-weight:750; letter-spacing:-.02em; display:flex; align-items:center; gap:9px; white-space:nowrap; }
.brand-mark { width:30px; height:30px; display:grid; place-items:center; border-radius:9px; background:var(--accent-soft); font-size:17px; }
.primary-nav { display:flex; gap:4px; align-self:stretch; align-items:center; }
.primary-nav a { color:var(--muted); font-weight:650; padding:8px 11px; border-radius:8px; transition:background .15s,color .15s; white-space:nowrap; }
.primary-nav a:hover { color:var(--fg); background:var(--hover); }
.primary-nav a[aria-current="page"] { color:var(--accent); background:var(--accent-soft); }
.step-number { display:inline-grid; place-items:center; width:20px; height:20px; margin-right:6px; border:1px solid var(--field-line); border-radius:999px; color:var(--muted); font-size:11px; line-height:1; }
.primary-nav a[aria-current="page"] .step-number { border-color:var(--accent); color:var(--accent); }
.nav-menu { position:relative; }
.nav-menu > summary { list-style:none; cursor:pointer; color:var(--muted); font-weight:600; padding:8px 11px; border-radius:8px; white-space:nowrap; transition:background .15s,color .15s; }
.nav-menu > summary::-webkit-details-marker { display:none; }
.nav-menu > summary:hover, .nav-menu[open] > summary { color:var(--fg); background:var(--hover); }
.nav-menu > summary[aria-current="page"] { color:var(--accent); background:var(--accent-soft); }
.nav-menu-caret { display:inline-block; margin-left:4px; transition:transform .15s; }
.nav-menu[open] .nav-menu-caret { transform:rotate(180deg); }
.management-compact { display:none; font-size:18px; line-height:1; letter-spacing:1px; }
.nav-menu-panel { position:absolute; top:calc(100% + 8px); right:0; z-index:20; min-width:220px; padding:7px; background:var(--card); border:1px solid var(--line); border-radius:12px; box-shadow:var(--shadow); }
.nav-menu-panel a, .nav-menu-panel button { display:block; width:100%; min-height:0; padding:9px 11px; border:0; border-radius:8px; background:transparent; color:var(--ghost-fg); text-align:left; font-weight:550; line-height:1.4; }
.nav-menu-panel a:hover, .nav-menu-panel button:hover { background:var(--hover); color:var(--fg); }
.nav-menu-panel a[aria-current="page"] { background:var(--accent-soft); color:var(--accent); }
.nav-menu-panel form { margin:4px 0 0; padding-top:4px; border-top:1px solid var(--line); }
.header-actions { margin-left:auto; display:flex; gap:8px; align-items:center; }
main { max-width:1120px; margin:0 auto; padding:32px 24px 56px; }
main.wide { max-width:1600px; }
h1 { margin:0 0 20px; font-size:26px; line-height:1.2; letter-spacing:-.025em; }
h2 { margin:0 0 14px; font-size:16px; line-height:1.35; letter-spacing:-.01em; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin:14px 0; box-shadow:var(--shadow); }
.collection-filter { display:flex; align-items:center; justify-content:space-between; gap:8px 16px; flex-wrap:wrap; margin:10px 0; font-size:13px; }
.paid-switch { position:relative; display:inline-flex; align-items:center; gap:8px; margin:0; cursor:pointer; }
.paid-switch input { position:absolute; width:38px; height:22px; min-height:0; padding:0; opacity:0; }
.paid-switch-track { width:38px; height:22px; border-radius:11px; background:var(--track); border:1px solid var(--field-line); transition:background .15s; }
.paid-switch-track:after { content:''; display:block; width:16px; height:16px; margin:2px; border-radius:50%; background:var(--fg); transition:transform .15s; }
.paid-switch input:checked + .paid-switch-track { background:var(--ok); }
.paid-switch input:checked + .paid-switch-track:after { transform:translateX(16px); background:#fff; }
.paid-switch input:focus-visible + .paid-switch-track { outline:2px solid var(--fg); outline-offset:3px; }
.table-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
details.card > summary { list-style:none; }
details.card > summary::-webkit-details-marker { display:none; }
details.card > summary:after { content:'+'; float:right; color:var(--muted); font-size:20px; line-height:1; }
details.card[open] > summary:after { content:'−'; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:12px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
tbody tr:last-child td { border-bottom:0; }
tbody tr { transition:background .12s; }
tbody tr:hover { background:var(--row-hover); }
th { color:var(--muted); font-weight:650; font-size:12px; text-transform:uppercase; letter-spacing:.045em; }
.badge { display:inline-flex; align-items:center; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:650; line-height:1.4; }
.badge.yes { background:var(--ok-soft); color:var(--ok); }
.badge.no { background:var(--danger-soft); color:var(--danger); }
.badge.red { background:var(--danger-soft); color:var(--danger); }
.badge.black { background:var(--track); color:var(--fg); }
.badge.both { background:#e9e1ff; color:#6546a5; }
.team-cell { min-height:0; padding:0; border:0; background:transparent; cursor:pointer; }
.team-cell:hover { background:transparent; border-color:transparent; transform:none; }
.team-cell .badge { pointer-events:none; }
input,select,textarea,button { font:inherit; }
input,select,textarea { background:var(--field); color:var(--fg); border:1px solid var(--field-line); border-radius:9px; padding:9px 11px; width:100%; min-height:40px; outline:none; transition:border-color .15s,box-shadow .15s,background .15s; }
textarea { resize:vertical; }
input:hover,select:hover,textarea:hover { border-color:var(--muted); }
input:focus,select:focus,textarea:focus { background:var(--card); border-color:var(--accent); box-shadow:0 0 0 3px rgba(232,93,42,.13); }
input[type="checkbox"] { accent-color:var(--accent); min-height:auto; }
.row { display:flex; gap:12px; flex-wrap:wrap; align-items:end; }
.row > div { flex:1; min-width:120px; }
a.button { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; font-size:13px; }
.settlement-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex-shrink:0; }
.budget-months { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
label { display:block; font-size:12px; font-weight:600; color:var(--muted); margin-bottom:6px; }
button,a.button { background:var(--accent); color:#fff; border:1px solid var(--accent); border-radius:9px; min-height:40px; padding:8px 14px; cursor:pointer; font-weight:650; transition:background .15s,border-color .15s,transform .08s; }
button:hover,a.button:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
button:disabled { opacity:.45; cursor:not-allowed; }
button[data-correction-confirm]:disabled { background:var(--track); border-color:var(--field-line); color:var(--muted); opacity:1; }
button:active { transform:translateY(1px); }
button.loading { opacity:.8; cursor:wait; }
button.loading::before { content:""; display:inline-block; width:13px; height:13px; margin-right:8px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; vertical-align:-2px; animation:button-spin .7s linear infinite; }
@keyframes button-spin { to { transform:rotate(360deg); } }
button.ghost,a.button.ghost { background:var(--card); border-color:var(--field-line); color:var(--ghost-fg); }
button.ghost:hover,a.button.ghost:hover { background:var(--hover); border-color:var(--muted); color:var(--fg); }
.theme-toggle { width:40px; padding:0; display:grid; place-items:center; font-size:17px; }
button.ok { background:var(--ok); border-color:var(--ok); }
button.ok:hover { background:var(--ok-hover); border-color:var(--ok-hover); }
button.danger { background:var(--danger); border-color:var(--danger); }
button.danger:hover { filter:brightness(.92); }
.inline { display:inline; }
.muted { color:var(--muted); }
.right { text-align:right; }
.flash-error { background:var(--danger-soft)!important; border-color:var(--danger)!important; color:var(--danger)!important; }
.flash { background:var(--ok-soft); border:1px solid var(--flash-line); color:var(--flash-fg); padding:11px 14px; border-radius:10px; margin:0 0 16px; font-weight:550; }
.workflow-check { display:flex; align-items:center; gap:12px; justify-content:space-between; padding:13px 15px; margin:0 0 14px; border:1px solid var(--line); border-radius:11px; background:var(--field); }
.workflow-check-main { display:flex; align-items:flex-start; gap:10px; min-width:0; }
.workflow-check-text { min-width:0; }
.workflow-check-text strong { display:block; margin-bottom:2px; }
.workflow-check a { flex:none; font-weight:650; }
.budget-preview-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.9fr); gap:16px; align-items:start; }
.budget-preview-message { min-width:0; white-space:pre-wrap; background:var(--field); border:1px solid var(--line); border-radius:10px; padding:14px; overflow-wrap:anywhere; }
.budget-correction-panel { min-width:0; background:var(--field); border:1px solid var(--line); border-radius:10px; padding:16px; }
.budget-correction-panel h3 { margin:0 0 8px; font-size:15px; }
.budget-correction-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:12px 0; }
.budget-correction-actions { display:flex; gap:6px; }
.budget-correction-actions button { min-width:40px; padding:6px 10px; }
@media (max-width:850px){ .budget-preview-grid { grid-template-columns:1fr; } }
.restore-guide li { margin:0 0 12px; }
.restore-guide pre { overflow-x:auto; padding:12px; background:var(--field); border:1px solid var(--line); border-radius:9px; font-size:12px; line-height:1.55; }
.login-wrap { max-width:390px; margin:12vh auto; padding:28px; }
@media (max-width:600px){
  header { padding:10px 14px; min-height:auto; gap:10px; flex-wrap:wrap; }
  .brand { flex:1; }
  .brand > span:last-child { display:none; }
  .primary-nav { order:3; width:100%; min-width:0; overflow-x:auto; padding-top:2px; }
  .primary-nav a { padding:7px 9px; }
  .nav-menu-panel { right:0; }
  .management-label { display:none; }
  .management-compact { display:inline; }
  .nav-menu > summary { padding:7px 8px; }
  .workflow-check { align-items:flex-start; }
  main{padding:22px 12px 40px;}
  h1 { font-size:23px; margin-bottom:16px; }
  .card { padding:15px; border-radius:12px; overflow-x:auto; }
  button { min-height:38px; }
  /* Обычные таблицы (игроки и т.п.): прячем второстепенные колонки 4+. */
  table:not(.pay-table):not(.schedule-table) th:nth-child(n+4),
  table:not(.pay-table):not(.schedule-table) td:nth-child(n+4){ display:none; }
  /* Таблица оплат: на узком экране оставляем ФИО(1), Итого(7) и кнопку(9),
     иначе кнопка «Перевёл» уезжает за край и недоступна в портретной ориентации. */
  .pay-table th:nth-child(2), .pay-table td:nth-child(2),
  .pay-table th:nth-child(3), .pay-table td:nth-child(3),
  .pay-table th:nth-child(4), .pay-table td:nth-child(4),
  .pay-table th:nth-child(5), .pay-table td:nth-child(5),
  .pay-table th:nth-child(6), .pay-table td:nth-child(6),
  .pay-table th:nth-child(8), .pay-table td:nth-child(8){ display:none; }
  /* Таблица игроков: оставляем ФИО(1), Статус(4) и колонку действий(7)
     (Изменить / Активировать / удалить), скрываем tg(2), Команду(3), даты(5,6). */
  .players-table th:nth-child(2), .players-table td:nth-child(2),
  .players-table th:nth-child(3), .players-table td:nth-child(3),
  .players-table th:nth-child(5), .players-table td:nth-child(5),
  .players-table th:nth-child(6), .players-table td:nth-child(6){ display:none; }
  /* Таблица игр: оставляем Соперник(3), Тренер(6), Судья(7) и удаление(8),
     чтобы тумблеры и кнопка были доступны в портретной ориентации. */
  .games-table th:nth-child(1), .games-table td:nth-child(1),
  .games-table th:nth-child(2), .games-table td:nth-child(2),
  .games-table th:nth-child(4), .games-table td:nth-child(4),
  .games-table th:nth-child(5), .games-table td:nth-child(5){ display:none; }
  /* Расписание: на мобильном оставляем пары команд, дату, время, площадку,
     признак дубля и действие с ним. */
  .schedule-table th:nth-child(1), .schedule-table td:nth-child(1),
  .schedule-table th:nth-child(2), .schedule-table td:nth-child(2),
  .schedule-table th:nth-child(9), .schedule-table td:nth-child(9),
  .schedule-table th:nth-child(10), .schedule-table td:nth-child(10),
  .schedule-table th:nth-child(11), .schedule-table td:nth-child(11){ display:none; }
}
`;

export function layout(
  title: string,
  body: string,
  opts: { nav?: boolean; flash?: string; wide?: boolean } = {},
): string {
  const primarySections = [
    ['1', 'Расписание', '/schedule'],
    ['2', 'Игры', '/games'],
    ['3', 'Расчеты', '/collections'],
  ] as const;
  const managementSections = [
    ['Игроки', '/players'],
    ['Разовые сборы', '/extra-fees'],
    ['Тарифы', '/tariffs'],
    ['Теги', '/tags'],
    ['Крон', '/cron'],
    ['Резервные копии', '/backups'],
  ] as const;
  const isCurrent = (label: string) => title === label || title.startsWith(label.slice(0, -1)) ||
    (label === 'Расчеты' && title.startsWith('Расчёт бюджета'));
  const primaryLinks = primarySections
    .map(([step, label, href]) => `<a href="${href}"${isCurrent(label) ? ' aria-current="page"' : ''}><span class="step-number">${step}</span>${label}</a>`)
    .join('');
  const managementActive = managementSections.some(([label]) => isCurrent(label));
  const managementLinks = managementSections
    .map(([label, href]) => `<a href="${href}"${isCurrent(label) ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  const nav = opts.nav === false ? '' : `
    <header>
      <a class="brand" href="/"><span class="brand-mark">🏀</span><span>basketballgod</span></a>
      <nav class="primary-nav" aria-label="Основной рабочий процесс">${primaryLinks}</nav>
      <div class="header-actions">
        ${TELEGRAM_STATUS_HTML}
        <details class="nav-menu"${managementActive ? ' open' : ''}>
          <summary aria-label="Управление"${managementActive ? ' aria-current="page"' : ''}><span class="management-label">Управление</span><span class="management-compact" aria-hidden="true">•••</span><span class="nav-menu-caret">▾</span></summary>
          <div class="nav-menu-panel">
            ${managementLinks}
            <form method="post" action="/sync/push"><button type="submit" title="Выгрузить все данные из БД в Google-таблицу">Выгрузить всё</button></form>
          </div>
        </details>
        <button class="ghost theme-toggle" id="theme-toggle" type="button" aria-label="Включить тёмную тему" title="Включить тёмную тему">☾</button>
        <form class="inline" method="post" action="/logout"><button class="ghost">Выйти</button></form>
      </div>
    </header>`;
  const isError = !!opts.flash && /^(Ошибка|Отправка сбора заблокирована|Не удалось)/i.test(opts.flash);
  const flash = opts.flash ? `<div class="flash${isError ? ' flash-error' : ''}" role="${isError ? 'alert' : 'status'}">${esc(opts.flash)}</div>` : '';
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — basketballgod</title>
<script>(function(){try{var saved=localStorage.getItem('bbg_theme');var theme=saved||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=theme}catch(e){}})()</script>
<style>${STYLE}${TELEGRAM_STATUS_STYLE}</style></head>
<body>${nav}<main${opts.wide ? ' class="wide"' : ''}>${flash}${body}</main>
<script>(function(){var button=document.getElementById('theme-toggle');if(!button)return;function render(){var dark=document.documentElement.dataset.theme==='dark';button.textContent=dark?'☀':'☾';button.setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');button.title=button.getAttribute('aria-label')||''}button.addEventListener('click',function(){var theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('bbg_theme',theme)}catch(e){}render()});render()})();
(function(){var menu=document.querySelector('.nav-menu');if(!menu)return;document.addEventListener('click',function(event){if(menu.open&&!menu.contains(event.target))menu.removeAttribute('open')});document.addEventListener('keydown',function(event){if(event.key==='Escape')menu.removeAttribute('open')})})();
${FORM_BUSY_SCRIPT}
${opts.nav === false ? '' : TELEGRAM_STATUS_SCRIPT}</script>
</body></html>`;
}

/**
 * Кнопка выгрузки раздела в соответствующую вкладку Google-таблицы (БД → таблица).
 * Синхронизация односторонняя: таблица — витрина для показа, обратно не читается.
 */
export function syncButtons(section: string): string {
  return `<div style="display:flex;gap:8px;flex-wrap:wrap">
    <form class="inline" method="post" action="/${section}/push"><button class="ghost">⬆ Выгрузить в таблицу</button></form>
  </div>`;
}

/** Прогресс-бар сбора: сколько собрано из нужной суммы + процент. */
export function progressBar(paid: number, total: number): string {
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  return `<div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
      <span class="muted">Собрано ${paid}₽ из ${total}₽</span>
      <b style="font-size:1.1rem">${pct}%</b>
    </div>
    <div style="height:12px;background:var(--track);border:1px solid var(--line);border-radius:999px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:var(--ok);transition:width .2s"></div>
    </div>
  </div>`;
}

export function teamBadge(team: string): string {
  if (team === 'BOTH') return '<span class="badge both">Black/Red</span>';
  if (team === 'COMMON') return '<span class="badge both">Общий</span>';
  const cls = team === 'RED' ? 'red' : 'black';
  return `<span class="badge ${cls}">${esc(team === 'RED' ? 'Red' : 'Black')}</span>`;
}

export function activeBadge(active: boolean): string {
  return active ? `<span class="badge yes">активен</span>` : `<span class="badge no">нет</span>`;
}

/**
 * Заголовок-ссылка для сортировки таблицы. Клик по активной колонке
 * переключает направление; иначе сортирует по возрастанию.
 */
export function sortHeader(
  label: string,
  key: string,
  base: string,
  cur: { sort: string; dir: 'asc' | 'desc' },
): string {
  const active = cur.sort === key;
  const nextDir = active && cur.dir === 'asc' ? 'desc' : 'asc';
  const arrow = active ? (cur.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const href = `${base}?sort=${encodeURIComponent(key)}&dir=${nextDir}`;
  return `<th><a href="${href}" style="color:inherit;text-decoration:none;white-space:nowrap">${esc(label)}${arrow}</a></th>`;
}
