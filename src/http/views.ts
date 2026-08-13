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
:root { --bg:#0f1115; --card:#1a1d24; --fg:#e7e9ee; --muted:#9aa3b2; --accent:#e23b3b; --ok:#2ecc71; --line:#2a2f3a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; line-height:1.5; }
header { background:var(--card); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; position:sticky; top:0; }
header a { color:var(--fg); text-decoration:none; font-weight:600; }
header nav { display:flex; gap:14px; flex-wrap:wrap; }
header nav a { color:var(--muted); font-weight:500; }
header nav a:hover { color:var(--fg); }
main { max-width: 960px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:12px 0; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
th { color:var(--muted); font-weight:600; font-size:.85rem; }
.badge { padding:2px 8px; border-radius:999px; font-size:.8rem; }
.badge.yes { background:rgba(46,204,113,.15); color:var(--ok); }
.badge.no { background:rgba(226,59,59,.15); color:var(--accent); }
.badge.red { background:rgba(226,59,59,.15); color:#ff8585; }
.badge.black { background:rgba(255,255,255,.1); color:#cfd3dc; }
input,select,button { font:inherit; }
input,select { background:#11141a; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; width:100%; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
.row > div { flex:1; min-width:120px; }
label { display:block; font-size:.8rem; color:var(--muted); margin-bottom:4px; }
button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; font-weight:600; }
button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
button.ok { background:var(--ok); }
.inline { display:inline; }
.muted { color:var(--muted); }
.right { text-align:right; }
.flash { background:rgba(46,204,113,.12); border:1px solid var(--ok); color:#aef0c8; padding:10px 12px; border-radius:8px; margin:8px 0; }
.login-wrap { max-width:360px; margin:10vh auto; }
@media (max-width:600px){
  main{padding:10px;}
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
}
`;

export function layout(title: string, body: string, opts: { nav?: boolean; flash?: string } = {}): string {
  const nav = opts.nav === false ? '' : `
    <header>
      <a href="/">🏀 basketballgod</a>
      <nav>
        <a href="/players">Игроки</a>
        <a href="/tariffs">Тарифы</a>
        <a href="/cron">Крон</a>
        <a href="/tags">Теги</a>
        <a href="/budgets">Бюджеты</a>
      </nav>
      <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
        <form class="inline" method="post" action="/sync/push"><button class="ghost" title="Выгрузить все данные из БД в Google-таблицу (только показать; обратно не читается)">⬆ Всё в таблицу</button></form>
        <form class="inline" method="post" action="/logout"><button class="ghost">Выйти</button></form>
      </div>
    </header>`;
  const flash = opts.flash ? `<div class="flash">${esc(opts.flash)}</div>` : '';
  return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — basketballgod</title><style>${STYLE}</style></head>
<body>${nav}<main>${flash}${body}</main></body></html>`;
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
    <div style="height:12px;background:#11141a;border:1px solid var(--line);border-radius:999px;overflow:hidden">
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
