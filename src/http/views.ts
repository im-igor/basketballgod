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
header nav { display:flex; gap:4px; align-self:stretch; align-items:center; }
header nav a { color:var(--muted); font-weight:550; padding:8px 11px; border-radius:8px; transition:background .15s,color .15s; }
header nav a:hover { color:var(--fg); background:var(--hover); }
header nav a[aria-current="page"] { color:var(--accent); background:var(--accent-soft); }
.header-actions { margin-left:auto; display:flex; gap:8px; align-items:center; }
main { max-width:1120px; margin:0 auto; padding:32px 24px 56px; }
h1 { margin:0 0 20px; font-size:26px; line-height:1.2; letter-spacing:-.025em; }
h2 { margin:0 0 14px; font-size:16px; line-height:1.35; letter-spacing:-.01em; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin:14px 0; box-shadow:var(--shadow); }
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
input,select,button { font:inherit; }
input,select { background:var(--field); color:var(--fg); border:1px solid var(--field-line); border-radius:9px; padding:9px 11px; width:100%; min-height:40px; outline:none; transition:border-color .15s,box-shadow .15s,background .15s; }
input:hover,select:hover { border-color:var(--muted); }
input:focus,select:focus { background:var(--card); border-color:var(--accent); box-shadow:0 0 0 3px rgba(232,93,42,.13); }
input[type="checkbox"] { accent-color:var(--accent); min-height:auto; }
.row { display:flex; gap:12px; flex-wrap:wrap; align-items:end; }
.row > div { flex:1; min-width:120px; }
label { display:block; font-size:12px; font-weight:600; color:var(--muted); margin-bottom:6px; }
button { background:var(--accent); color:#fff; border:1px solid var(--accent); border-radius:9px; min-height:40px; padding:8px 14px; cursor:pointer; font-weight:650; transition:background .15s,border-color .15s,transform .08s; }
button:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
button:active { transform:translateY(1px); }
button.ghost { background:var(--card); border-color:var(--field-line); color:var(--ghost-fg); }
button.ghost:hover { background:var(--hover); border-color:var(--muted); color:var(--fg); }
.theme-toggle { width:40px; padding:0; display:grid; place-items:center; font-size:17px; }
button.ok { background:var(--ok); border-color:var(--ok); }
button.ok:hover { background:var(--ok-hover); border-color:var(--ok-hover); }
.inline { display:inline; }
.muted { color:var(--muted); }
.right { text-align:right; }
.flash { background:var(--ok-soft); border:1px solid var(--flash-line); color:var(--flash-fg); padding:11px 14px; border-radius:10px; margin:0 0 16px; font-weight:550; }
.login-wrap { max-width:390px; margin:12vh auto; padding:28px; }
@media (max-width:600px){
  header { padding:10px 14px; min-height:auto; gap:10px; flex-wrap:wrap; }
  .brand { flex:1; }
  header nav { order:3; width:100%; overflow-x:auto; padding-top:2px; }
  header nav a { white-space:nowrap; padding:7px 9px; }
  .header-actions form:first-child { display:none; }
  main{padding:22px 12px 40px;}
  h1 { font-size:23px; margin-bottom:16px; }
  .card { padding:15px; border-radius:12px; overflow-x:auto; }
  button { min-height:38px; }
  /* Обычные таблицы (игроки и т.п.): прячем второстепенные колонки 4+. */
  table:not(.pay-table) th:nth-child(n+4),
  table:not(.pay-table) td:nth-child(n+4){ display:none; }
  /* Таблица оплат: на узком экране оставляем только ФИО(1), Итого(6) и кнопку(8),
     иначе кнопка «Перевёл» уезжает за край и недоступна в портретной ориентации. */
  .pay-table th:nth-child(2), .pay-table td:nth-child(2),
  .pay-table th:nth-child(3), .pay-table td:nth-child(3),
  .pay-table th:nth-child(4), .pay-table td:nth-child(4),
  .pay-table th:nth-child(5), .pay-table td:nth-child(5),
  .pay-table th:nth-child(7), .pay-table td:nth-child(7){ display:none; }
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
}
`;

export function layout(title: string, body: string, opts: { nav?: boolean; flash?: string } = {}): string {
  const sections = [
    ['Игроки', '/players'], ['Тарифы', '/tariffs'], ['Крон', '/cron'],
    ['Теги', '/tags'], ['Бюджеты', '/budgets'], ['Игры', '/games'],
  ] as const;
  const navLinks = sections
    .map(([label, href]) => `<a href="${href}"${title === label || title.startsWith(label.slice(0, -1)) ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  const nav = opts.nav === false ? '' : `
    <header>
      <a class="brand" href="/"><span class="brand-mark">🏀</span><span>basketballgod</span></a>
      <nav>${navLinks}</nav>
      <div class="header-actions">
        <button class="ghost theme-toggle" id="theme-toggle" type="button" aria-label="Включить тёмную тему" title="Включить тёмную тему">☾</button>
        <form class="inline" method="post" action="/sync/push"><button class="ghost" title="Выгрузить все данные из БД в Google-таблицу (только показать; обратно не читается)">Выгрузить всё</button></form>
        <form class="inline" method="post" action="/logout"><button class="ghost">Выйти</button></form>
      </div>
    </header>`;
  const flash = opts.flash ? `<div class="flash">${esc(opts.flash)}</div>` : '';
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — basketballgod</title>
<script>(function(){try{var saved=localStorage.getItem('bbg_theme');var theme=saved||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=theme}catch(e){}})()</script>
<style>${STYLE}</style></head>
<body>${nav}<main>${flash}${body}</main>
<script>(function(){var button=document.getElementById('theme-toggle');if(!button)return;function render(){var dark=document.documentElement.dataset.theme==='dark';button.textContent=dark?'☀':'☾';button.setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');button.title=button.getAttribute('aria-label')||''}button.addEventListener('click',function(){var theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('bbg_theme',theme)}catch(e){}render()});render()})()</script>
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
  const cls = team === 'RED' ? 'red' : 'black';
  return `<span class="badge ${cls}">${esc(team)}</span>`;
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
