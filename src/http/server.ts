import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { webhookCallback, type Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { layout, esc, teamBadge, activeBadge, sortHeader, syncButtons, progressBar } from './views.js';
import { normalizeLogin } from '../util/args.js';
import { computeActivityDates, reconcileActivityDates } from '../domain/activity.js';
import {
  listPlayers,
  getByLogin,
  upsertPlayer,
  setActive,
  deletePlayer,
} from '../db/repos/players.repo.js';
import { getTariffs, updateTariffs } from '../db/repos/tariffs.repo.js';
import { getCronConfig, updateCronConfig } from '../db/repos/cronConfig.repo.js';
import { listTags, upsertTag, deleteTag } from '../db/repos/tags.repo.js';
import {
  listBudgets,
  getBudget,
  getBudgetById,
  getCharges,
  setChargePaid,
} from '../db/repos/budgets.repo.js';
import { listAllGamesForMonth, deleteGameById } from '../db/repos/games.repo.js';
import { buildAndSaveBudgets, recalcBudget } from '../services/budget.service.js';
import { registerManualGame, recomputeGameFee } from '../services/gameFee.service.js';
import {
  sendBudgetToChat,
  refreshBudgetMessage,
  sendDebtors,
  sendBudgetDraftsByMonth,
  renderBudgetFromDb,
} from '../services/notify.service.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import {
  syncAllToSheet,
  exportPlayersToSheet,
  exportTariffsToSheet,
  exportCronToSheet,
  exportTagsToSheet,
} from '../services/sheetSync.service.js';
import { monthLabel, isoToRu } from '../domain/dates.js';
import { formatFullName } from '../domain/messages.js';
import type { Team, Player, Charge } from '../db/types.js';

const COOKIE = 'bbg_auth';
const PUBLIC = new Set(['/login', '/healthz']);

function isAuthed(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const r = req.unsignCookie(raw);
  return r.valid && r.value === '1';
}

function redirect(reply: FastifyReply, to: string, msg?: string): FastifyReply {
  const url = msg ? `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : to;
  return reply.redirect(url);
}

function html(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').send(body);
}

/** Обработчик кнопки синхронизации: запускает fn и редиректит на `back` со сводкой/ошибкой. */
function syncRoute(back: string, fn: () => Promise<string>) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    try {
      return redirect(reply, back, await fn());
    } catch (err) {
      return redirect(reply, back, `Ошибка: ${(err as Error).message}`);
    }
  };
}

export async function buildServer(bot: Bot) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(formbody);

  const api = bot.api;

  // Telegram webhook (если включён режим webhook)
  if (env.TELEGRAM_USE_WEBHOOK && env.WEBHOOK_SECRET) {
    app.post(`/webhook/${env.WEBHOOK_SECRET}`, webhookCallback(bot, 'fastify'));
  }

  app.get('/healthz', async () => ({ ok: true }));

  // Авторизация на все остальные маршруты
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (PUBLIC.has(path) || path.startsWith('/webhook/')) return;
    if (!isAuthed(req)) {
      redirect(reply, '/login');
    }
  });

  // ── Login ────────────────────────────────────────────────
  app.get('/login', async (req, reply) => {
    const err = (req.query as Record<string, string>).err ? '<p class="badge no">Неверный логин или пароль</p>' : '';
    const body = `<div class="login-wrap card">
      <h1>Вход</h1>${err}
      <form method="post" action="/login">
        <label>Логин</label><input name="username" autocomplete="username">
        <label style="margin-top:8px">Пароль</label><input type="password" name="password" autocomplete="current-password">
        <button style="margin-top:12px;width:100%">Войти</button>
      </form></div>`;
    return html(reply, layout('Вход', body, { nav: false }));
  });

  app.post('/login', async (req, reply) => {
    const b = req.body as { username?: string; password?: string };
    if (b.username === env.ADMIN_USERNAME && b.password === env.ADMIN_PASSWORD) {
      reply.setCookie(COOKIE, '1', {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });
      return redirect(reply, '/');
    }
    return redirect(reply, '/login?err=1');
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return redirect(reply, '/login');
  });

  // ── Dashboard ────────────────────────────────────────────
  app.get('/', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const body = `<h1>Панель управления</h1>
      <div class="card"><h2>Быстрые действия</h2>
        <div class="row">
          <form method="post" action="/polls/run/training"><button>Разослать опросы на тренировки</button></form>
          <form method="post" action="/polls/run/game"><button>Разослать опросы на игры</button></form>
          <form method="post" action="/budgets/build" class="row">
            <div><label>Месяц</label><input name="month" type="number" min="1" max="12" required></div>
            <div><label>Год</label><input name="year" type="number" min="2024" max="2100" required></div>
            <div><button class="ghost">Собрать бюджет</button></div>
          </form>
        </div>
      </div>
      <div class="card muted">Раздел «Бюджеты» — отправка сборов, отметки оплат и напоминания должникам.</div>`;
    return html(reply, layout('Главная', body, { flash: msg }));
  });

  // ── Players (источник правды — БД; выгрузка во вкладку Players по кнопке) ────
  // date-значение из БД (Date или ISO-строка) → YYYY-MM-DD для input[type=date].
  const isoDate = (v: string | Date | null | undefined): string => {
    if (!v) return '';
    if (v instanceof Date) {
      const mm = String(v.getMonth() + 1).padStart(2, '0');
      const dd = String(v.getDate()).padStart(2, '0');
      return `${v.getFullYear()}-${mm}-${dd}`;
    }
    return String(v).slice(0, 10);
  };

  // Полная форма игрока (добавление/редактирование). Пишет в БД.
  const playerForm = (p?: Player): string => {
    const sel = (t: Team) => (p?.team === t ? 'selected' : '');
    const chk = (b: boolean) => (b ? 'checked' : '');
    return `<form method="post" action="/players">
      <input type="hidden" name="orig_login" value="${esc(p?.tg_login ?? '')}">
      <div class="row">
        <div><label>ФИО</label><input name="name" value="${esc(p?.name ?? '')}" required></div>
        <div><label>tg_login</label><input name="tg_login" value="${esc(p?.tg_login ?? '')}" placeholder="@login" required></div>
        <div><label>Команда</label><select name="team"><option ${sel('RED')}>RED</option><option ${sel('BLACK')}>BLACK</option></select></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div style="flex:0"><label>Сотрудник</label><input type="checkbox" name="is_employee" value="yes" ${chk(p?.is_employee ?? false)} style="width:auto"></div>
        <div style="flex:0"><label>Активен</label><input type="checkbox" name="active" value="yes" ${chk(p?.active ?? true)} style="width:auto"></div>
        <div><label>Активен с</label><input name="active_from" type="date" value="${esc(isoDate(p?.active_from))}"></div>
        <div><label>Активен по</label><input name="active_to" type="date" value="${esc(isoDate(p?.active_to))}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div><label>Заметки</label><input name="notes" value="${esc(p?.notes ?? '')}"></div>
        <div style="flex:0"><label>&nbsp;</label><button>Сохранить</button></div>
      </div>
    </form>`;
  };

  // Компараторы для сортировки списка игроков по колонкам таблицы.
  const PLAYER_SORTS: Record<string, (a: Player, b: Player) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
    tg_login: (a, b) => a.tg_login.localeCompare(b.tg_login, 'ru'),
    team: (a, b) => a.team.localeCompare(b.team),
    active: (a, b) => Number(a.active) - Number(b.active),
    active_from: (a, b) => isoDate(a.active_from).localeCompare(isoDate(b.active_from)),
    active_to: (a, b) => isoDate(a.active_to).localeCompare(isoDate(b.active_to)),
  };

  // Клиентский фильтр списка игроков: контекстный поиск по ФИО + скрытие неактивных.
  // Работает поверх серверной сортировки, состояние чекбокса помним в localStorage.
  const playersFilterScript = `(function(){
    var search = document.getElementById('player-search');
    var hide = document.getElementById('hide-inactive');
    var empty = document.getElementById('player-empty');
    if (!search || !hide) return;
    var rows = Array.prototype.slice.call(document.querySelectorAll('.players-table tbody tr'));
    var KEY = 'bbg_hide_inactive';
    hide.checked = localStorage.getItem(KEY) === '1';
    function apply(){
      var q = (search.value || '').trim().toLowerCase();
      var hideInactive = hide.checked;
      var shown = 0;
      rows.forEach(function(tr){
        var name = tr.getAttribute('data-name') || '';
        var active = tr.getAttribute('data-active') === '1';
        var ok = (!q || name.indexOf(q) !== -1) && (!hideInactive || active);
        tr.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      if (empty) empty.style.display = shown === 0 ? '' : 'none';
    }
    search.addEventListener('input', apply);
    hide.addEventListener('change', function(){ localStorage.setItem(KEY, hide.checked ? '1' : '0'); apply(); });
    apply();
  })();`;

  app.get('/players', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const msg = q.msg;
    const sort = q.sort && PLAYER_SORTS[q.sort] ? q.sort : 'name';
    const dir: 'asc' | 'desc' = q.dir === 'desc' ? 'desc' : 'asc';
    const players = await listPlayers();
    const cmp = PLAYER_SORTS[sort]!;
    players.sort((a, b) => (dir === 'desc' ? -cmp(a, b) : cmp(a, b)));
    const rows = players
      .map(
        (p) => `<tr data-name="${esc(p.name.toLowerCase())}" data-active="${p.active ? '1' : '0'}">
        <td>${esc(p.name)}</td>
        <td class="muted">${esc(p.tg_login)}</td>
        <td>${teamBadge(p.team)}</td>
        <td>${activeBadge(p.active)}</td>
        <td>${esc(isoToRu(p.active_from))}</td>
        <td>${esc(isoToRu(p.active_to))}</td>
        <td class="right">
          <a href="/players/edit?login=${encodeURIComponent(p.tg_login)}" style="margin-right:8px">Изменить</a>
          <form class="inline" method="post" action="/players/active">
            <input type="hidden" name="login" value="${esc(p.tg_login)}">
            <input type="hidden" name="value" value="${p.active ? 'no' : 'yes'}">
            <button class="ghost">${p.active ? 'Деактивировать' : 'Активировать'}</button>
          </form>
          <form class="inline" method="post" action="/players/delete" onsubmit="return confirm('Удалить игрока из БД?')">
            <input type="hidden" name="login" value="${esc(p.tg_login)}">
            <button class="ghost">✕</button>
          </form>
        </td></tr>`,
      )
      .join('');

    const body = `<h1>Игроки <span class="muted">(${players.length})</span></h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Правки в этом разделе пишутся в БД — это единственный источник правды.
          Кнопка справа выгружает состав во вкладку «Players» Google-таблицы (чтобы показать человеку);
          обратно таблица не читается.</div>
        ${syncButtons('players')}
      </div></div>
      <details class="card"><summary style="cursor:pointer;font-weight:600;font-size:1.05rem">Добавить / обновить игрока</summary>
        <div style="margin-top:12px">${playerForm()}</div></details>
      <div class="card"><div class="row" style="align-items:end">
        <div style="flex:1"><label>Поиск по ФИО</label>
          <input id="player-search" placeholder="начни вводить фамилию или имя…" autocomplete="off"></div>
        <div style="flex:0"><label>&nbsp;</label>
          <label style="display:flex;gap:6px;align-items:center;white-space:nowrap;color:var(--fg)">
            <input type="checkbox" id="hide-inactive" style="width:auto"> скрыть неактивных</label></div>
      </div></div>
      <div class="card"><table class="players-table">
        <thead><tr>
          ${sortHeader('ФИО', 'name', '/players', { sort, dir })}
          ${sortHeader('tg', 'tg_login', '/players', { sort, dir })}
          ${sortHeader('Команда', 'team', '/players', { sort, dir })}
          ${sortHeader('Статус', 'active', '/players', { sort, dir })}
          ${sortHeader('С', 'active_from', '/players', { sort, dir })}
          ${sortHeader('По', 'active_to', '/players', { sort, dir })}
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody></table>
        <div id="player-empty" class="muted" style="display:none;padding:8px 10px">Никого не нашлось</div></div>
      <script>${playersFilterScript}</script>`;
    return html(reply, layout('Игроки', body, { flash: msg }));
  });

  app.get('/players/edit', async (req, reply) => {
    const login = (req.query as Record<string, string>).login;
    const player = login ? await getByLogin(login) : null;
    if (!player) return redirect(reply, '/players', 'Игрок не найден');
    const body = `<h1>Изменить игрока</h1>
      <div class="card">${playerForm(player)}</div>
      <div class="card"><a href="/players">← к списку игроков</a></div>`;
    return html(reply, layout('Изменить игрока', body));
  });

  app.post('/players', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const name = (b.name ?? '').trim();
    const tgLoginRaw = (b.tg_login ?? '').trim();
    if (!name || !tgLoginRaw || (b.team !== 'RED' && b.team !== 'BLACK')) {
      return redirect(reply, '/players', 'Заполни ФИО, tg_login и команду');
    }
    const tgLogin = normalizeLogin(tgLoginRaw);
    // Согласуем даты: устаревший active_to (раньше active_from) обнуляем.
    const dates = reconcileActivityDates(
      b.active_from ? b.active_from : null,
      b.active_to ? b.active_to : null,
    );
    await upsertPlayer({
      name,
      tg_login: tgLogin,
      team: b.team as Team,
      is_employee: b.is_employee === 'yes',
      active: b.active === 'yes',
      active_from: dates.active_from,
      active_to: dates.active_to,
      notes: (b.notes ?? '').trim() || null,
    });
    // Переименование tg_login: удаляем старую строку, если логин сменился.
    const origLogin = (b.orig_login ?? '').trim();
    if (origLogin && normalizeLogin(origLogin).toLowerCase() !== tgLogin.toLowerCase()) {
      const old = await getByLogin(origLogin);
      if (old) await deletePlayer(old.id);
    }
    return redirect(reply, '/players', 'Игрок сохранён');
  });

  app.post('/players/active', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const login = (b.login ?? '').trim();
    const value = b.value === 'yes';
    if (login) {
      const { active_from, active_to } = computeActivityDates(value);
      await setActive(login, value, active_from ?? null, active_to ?? null);
    }
    return redirect(reply, '/players', 'Статус обновлён');
  });

  app.post('/players/delete', async (req, reply) => {
    const login = ((req.body as Record<string, string>).login ?? '').trim();
    if (login) {
      const p = await getByLogin(login);
      if (p) await deletePlayer(p.id);
    }
    return redirect(reply, '/players', 'Игрок удалён из БД');
  });

  app.post('/players/push', syncRoute('/players', exportPlayersToSheet));

  // ── Tariffs ──────────────────────────────────────────────
  app.get('/tariffs', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const t = await getTariffs();
    const field = (name: string, label: string, val: number) =>
      `<div><label>${label}</label><input name="${name}" type="number" step="1" value="${val}"></div>`;
    const body = `<h1>Тарифы</h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Правки пишутся в БД. Кнопка справа — выгрузка во вкладку «tariffs» (только показать).</div>
        ${syncButtons('tariffs')}
      </div></div>
      <div class="card"><form method="post" action="/tariffs"><div class="row">
        ${field('coach_per_session', 'Тренер / тренировка', t.coach_per_session)}
        ${field('coach_per_game', 'Тренер / игра', t.coach_per_game)}
        ${field('gym_paid_price', 'Зал (платный)', t.gym_paid_price)}
        ${field('locker_rent_price', 'Шкафчик', t.locker_rent_price)}
        ${field('referee_default', 'Судья', t.referee_default)}
      </div><button style="margin-top:12px">Сохранить</button></form></div>`;
    return html(reply, layout('Тарифы', body, { flash: msg }));
  });

  app.post('/tariffs', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const num = (v: string | undefined) => (v !== undefined && v !== '' ? Number(v) : undefined);
    await updateTariffs({
      coach_per_session: num(b.coach_per_session),
      coach_per_game: num(b.coach_per_game),
      gym_paid_price: num(b.gym_paid_price),
      locker_rent_price: num(b.locker_rent_price),
      referee_default: num(b.referee_default),
    });
    return redirect(reply, '/tariffs', 'Тарифы сохранены');
  });

  app.post('/tariffs/push', syncRoute('/tariffs', exportTariffsToSheet));

  // ── Cron (расписание планировщика в cron_config) ─────────
  app.get('/cron', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const c = await getCronConfig();
    const val = (v: string | number | null): string => (v === null || v === undefined ? '' : String(v));
    const text = (name: string, label: string, v: string | null, ph = '') =>
      `<div><label>${label}</label><input name="${name}" value="${esc(val(v))}" placeholder="${ph}"></div>`;
    const numf = (name: string, label: string, v: number | null, ph = '') =>
      `<div><label>${label}</label><input name="${name}" type="number" value="${esc(val(v))}" placeholder="${ph}"></div>`;
    const body = `<h1>Крон</h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Расписание планировщика (в БД). Пустое поле → берётся значение из env/дефолтов.
          Кнопка справа — выгрузка во вкладку «cron» (только показать).</div>
        ${syncButtons('cron')}
      </div></div>
      <div class="card"><form method="post" action="/cron">
        <div class="row">
          ${text('timezone', 'Таймзона', c.timezone, 'Europe/Moscow')}
        </div>
        <h2 style="margin-top:12px">Опросы на тренировки</h2>
        <div class="row">
          ${numf('poll_training_weekday', 'День недели (1=Пн…7=Вс)', c.poll_training_weekday, '5')}
          ${text('poll_training_time', 'Время (ЧЧ:ММ)', c.poll_training_time, '12:00')}
          ${numf('poll_training_horizon_days', 'Горизонт (дней вперёд)', c.poll_training_horizon_days, '7')}
        </div>
        <h2 style="margin-top:12px">Опросы на игры</h2>
        <div class="row">
          ${numf('poll_game_weekday', 'День недели (1=Пн…7=Вс)', c.poll_game_weekday, '5')}
          ${text('poll_game_time', 'Время (ЧЧ:ММ)', c.poll_game_time, '12:00')}
          ${numf('poll_game_horizon_days', 'Горизонт (дней вперёд)', c.poll_game_horizon_days, '7')}
        </div>
        <div class="row" style="margin-top:8px">
          ${numf('fixation_day', 'Фиксация: день месяца (1–28)', c.fixation_day, '25')}
          ${text('fixation_time', 'Фиксация: время (ЧЧ:ММ)', c.fixation_time, '20:00')}
        </div>
        <div class="row" style="margin-top:8px">
          ${numf('budget_day', 'Бюджет: день месяца (1–28)', c.budget_day, '26')}
          ${text('budget_time', 'Бюджет: время (ЧЧ:ММ)', c.budget_time, '20:00')}
        </div>
        <button style="margin-top:12px">Сохранить</button>
      </form></div>`;
    return html(reply, layout('Крон', body, { flash: msg }));
  });

  app.post('/cron', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const str = (v: string | undefined) => (v !== undefined && v.trim() !== '' ? v.trim() : undefined);
    const int = (v: string | undefined) => {
      const s = str(v);
      if (s === undefined) return undefined;
      const n = Number(s);
      return Number.isInteger(n) ? n : undefined;
    };
    await updateCronConfig({
      timezone: str(b.timezone),
      poll_training_weekday: int(b.poll_training_weekday),
      poll_training_time: str(b.poll_training_time),
      poll_training_horizon_days: int(b.poll_training_horizon_days),
      poll_game_weekday: int(b.poll_game_weekday),
      poll_game_time: str(b.poll_game_time),
      poll_game_horizon_days: int(b.poll_game_horizon_days),
      fixation_day: int(b.fixation_day),
      fixation_time: str(b.fixation_time),
      budget_day: int(b.budget_day),
      budget_time: str(b.budget_time),
    });
    return redirect(reply, '/cron', 'Расписание сохранено');
  });

  app.post('/cron/push', syncRoute('/cron', exportCronToSheet));

  // ── Tags (справочник тегов календарных событий) ──────────
  app.get('/tags', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const tags = await listTags();
    const rows = tags
      .map(
        (t) => `<tr>
        <td><b>${esc(t.tag_key)}</b></td>
        <td>${esc(t.tag_value)}</td>
        <td class="muted">${esc(t.description ?? '')}</td>
        <td class="right"><form class="inline" method="post" action="/tags/delete" onsubmit="return confirm('Удалить тег?')">
          <input type="hidden" name="id" value="${t.id}">
          <button class="ghost">✕</button>
        </form></td></tr>`,
      )
      .join('');
    const body = `<h1>Теги <span class="muted">(${tags.length})</span></h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Справочник тегов календарных событий (легенда KEY=VALUE). Хранится в БД;
          кнопка справа — выгрузка во вкладку «Tags» (только показать). На валидацию парсинга не влияет.</div>
        ${syncButtons('tags')}
      </div></div>
      <div class="card"><h2>Добавить / обновить</h2>
        <form method="post" action="/tags"><div class="row">
          <div><label>Ключ (KEY)</label><input name="tag_key" placeholder="TYPE" required></div>
          <div><label>Значение (VALUE)</label><input name="tag_value" placeholder="TRAINING"></div>
          <div style="flex:2"><label>Описание</label><input name="description" placeholder="Тренировка"></div>
          <div style="flex:0"><label>&nbsp;</label><button>Сохранить</button></div>
        </div></form>
        <div class="muted" style="margin-top:6px">Обновление — по совпадению ключ+значение.</div>
      </div>
      <div class="card"><table>
        <thead><tr><th>Ключ</th><th>Значение</th><th>Описание</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">Пока нет тегов</td></tr>'}</tbody>
      </table></div>`;
    return html(reply, layout('Теги', body, { flash: msg }));
  });

  app.post('/tags', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const key = (b.tag_key ?? '').trim().toUpperCase();
    if (!key) return redirect(reply, '/tags', 'Укажи ключ тега');
    await upsertTag({
      tag_key: key,
      tag_value: (b.tag_value ?? '').trim(),
      description: (b.description ?? '').trim() || null,
    });
    return redirect(reply, '/tags', 'Тег сохранён');
  });

  app.post('/tags/delete', async (req, reply) => {
    const id = Number((req.body as Record<string, string>).id);
    if (Number.isInteger(id)) await deleteTag(id);
    return redirect(reply, '/tags', 'Тег удалён');
  });

  app.post('/tags/push', syncRoute('/tags', exportTagsToSheet));

  // ── Синхронизация всех вкладок (кнопки в шапке) ──────────
  app.post('/sync/push', syncRoute('/', syncAllToSheet));

  // ── Budgets ──────────────────────────────────────────────
  // Месяц/год по умолчанию: следующий месяц (номер) и текущий год.
  const defaultBudgetPeriod = (): { month: number; year: number } => {
    const now = new Date();
    const cur = now.getMonth() + 1;
    return { month: cur === 12 ? 1 : cur + 1, year: now.getFullYear() };
  };

  // Понятный сегмент URL бюджета: «MM-YYYY» (напр. 08-2026).
  const periodOf = (month: number, year: number): string =>
    `${String(month).padStart(2, '0')}-${year}`;
  const parsePeriod = (s: string | undefined): { month: number; year: number } | null => {
    const m = /^(\d{1,2})-(\d{4})$/.exec(s ?? '');
    if (!m) return null;
    const month = Number(m[1]);
    const year = Number(m[2]);
    if (!(month >= 1 && month <= 12) || !(year >= 2024)) return null;
    return { month, year };
  };

  // Дата-время (Date или ISO из БД) → «дд.мм.гггг ЧЧ:ММ» в таймзоне приложения.
  const fmtDateTime = (v: string | Date | null): string => {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('ru-RU', {
        timeZone: env.TZ,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  };

  app.get('/budgets', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const msg = q.msg;
    const def = defaultBudgetPeriod();
    const month = Number(q.month) >= 1 && Number(q.month) <= 12 ? Number(q.month) : def.month;
    const year = Number(q.year) >= 2024 ? Number(q.year) : def.year;

    // Список — один общий бюджет на месяц (обе команды в одной строке).
    const budgets = await listBudgets();
    const byMonth = new Map<string, typeof budgets>();
    for (const b of budgets) {
      const k = `${b.year}-${String(b.month).padStart(2, '0')}`;
      (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(b);
    }
    const rows = [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0])) // новые сверху
      .map(([, group]) => {
        const first = group[0]!;
        const red = group.find((g) => g.team === 'RED');
        const black = group.find((g) => g.team === 'BLACK');
        const baseInfo = [
          red ? `${teamBadge('RED')} ${red.total_per_player ?? '—'}₽` : '',
          black ? `${teamBadge('BLACK')} ${black.total_per_player ?? '—'}₽` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const sentCount = group.filter((g) => g.message_id).length;
        const status =
          sentCount === 0
            ? '<span class="badge no">черновик</span>'
            : sentCount === group.length
              ? '<span class="badge yes">отправлен</span>'
              : '<span class="badge red">частично</span>';
        return `<tr>
          <td><a href="/budgets/${periodOf(first.month, first.year)}">${esc(monthLabel(first.month, first.year))}</a></td>
          <td>${baseInfo}</td>
          <td>${status}</td>
        </tr>`;
      })
      .join('');

    // Черновики за выбранный период (обе команды) — если бюджеты уже собраны.
    const [redBudget, blackBudget] = await Promise.all([
      getBudget('RED', month, year),
      getBudget('BLACK', month, year),
    ]);
    const built = [redBudget, blackBudget].filter((b): b is NonNullable<typeof b> => !!b);
    let draftsCard = '';
    if (built.length > 0) {
      const previews: string[] = [];
      for (const b of built) {
        const rendered = await renderBudgetFromDb(b.id);
        if (!rendered) continue;
        previews.push(
          `<div style="margin-top:12px">
            <div class="muted" style="margin-bottom:6px">${teamBadge(b.team)} — <a href="/budgets/${periodOf(b.month, b.year)}">открыть</a></div>
            <div style="white-space:pre-wrap;background:#11141a;border:1px solid var(--line);border-radius:8px;padding:12px;overflow-wrap:anywhere">${rendered.text}</div>
          </div>`,
        );
      }
      const hidden = `<input type="hidden" name="month" value="${month}"><input type="hidden" name="year" value="${year}">`;
      draftsCard = `<div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Черновики за ${esc(monthLabel(month, year))}</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <form class="inline" method="post" action="/budgets/draft">${hidden}<button class="ghost">Отправить черновики в личку</button></form>
            <form class="inline" method="post" action="/budgets/publish" onsubmit="return confirm('Опубликовать сборы в чаты обеих команд?')">${hidden}<button>Отправить в чаты команд</button></form>
          </div>
        </div>
        ${previews.join('')}
      </div>`;
    }

    const body = `<h1>Бюджеты</h1>
      <div class="card"><h2>Собрать черновик</h2>
        <form method="post" action="/budgets/build" class="row">
          <div><label>Месяц</label><input name="month" type="number" min="1" max="12" value="${month}" required></div>
          <div><label>Год</label><input name="year" type="number" min="2024" max="2100" value="${year}" required></div>
          <div style="flex:0"><label>&nbsp;</label><button>Собрать</button></div>
        </form></div>
      ${draftsCard}
      <div class="card"><table>
        <thead><tr><th>Месяц</th><th>Базовый взнос</th><th>Статус</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">Пока нет бюджетов</td></tr>'}</tbody>
      </table></div>`;
    return html(reply, layout('Бюджеты', body, { flash: msg }));
  });

  /** Прочитать и провалидировать месяц/год из тела формы. */
  const readPeriod = (body: unknown): { month: number; year: number } | null => {
    const b = body as { month?: string; year?: string };
    const month = Number(b.month);
    const year = Number(b.year);
    if (!(month >= 1 && month <= 12) || !(year >= 2024)) return null;
    return { month, year };
  };

  app.post('/budgets/build', async (req, reply) => {
    const p = readPeriod(req.body);
    if (!p) return redirect(reply, '/budgets', 'Неверный месяц/год');
    await buildAndSaveBudgets(p.month, p.year);
    return redirect(
      reply,
      `/budgets?month=${p.month}&year=${p.year}`,
      `Черновики за ${monthLabel(p.month, p.year)} собраны для обеих команд`,
    );
  });

  // Отправить черновики бюджета обеих команд админам в личку (с кнопкой публикации).
  app.post('/budgets/draft', async (req, reply) => {
    const p = readPeriod(req.body);
    if (!p) return redirect(reply, '/budgets', 'Неверный месяц/год');
    const back = `/budgets?month=${p.month}&year=${p.year}`;
    try {
      const { sent } = await sendBudgetDraftsByMonth(api, p.month, p.year);
      return redirect(
        reply,
        back,
        sent ? `Черновики отправлены в личку (команд: ${sent})` : 'Нет собранных черновиков за период',
      );
    } catch (err) {
      return redirect(reply, back, `Ошибка: ${(err as Error).message}`);
    }
  });

  // Опубликовать сборы обеих команд в чаты команд.
  app.post('/budgets/publish', async (req, reply) => {
    const p = readPeriod(req.body);
    if (!p) return redirect(reply, '/budgets', 'Неверный месяц/год');
    const back = `/budgets?month=${p.month}&year=${p.year}`;
    try {
      let sent = 0;
      for (const team of ['RED', 'BLACK'] as Team[]) {
        const budget = await getBudget(team, p.month, p.year);
        if (budget) {
          await sendBudgetToChat(api, budget.id);
          sent++;
        }
      }
      return redirect(
        reply,
        back,
        sent ? `Сборы отправлены в чаты (команд: ${sent})` : 'Нет собранных бюджетов за период',
      );
    } catch (err) {
      return redirect(reply, back, `Ошибка: ${(err as Error).message}`);
    }
  });

  // Бюджеты обеих команд за месяц данного бюджета (существующие), отсортированы RED, BLACK.
  const monthBudgetsOf = async (month: number, year: number) => {
    const found = await Promise.all(
      (['RED', 'BLACK'] as Team[]).map((t) => getBudget(t, month, year)),
    );
    return found.filter((b): b is NonNullable<typeof b> => !!b);
  };

  app.get('/budgets/:period', async (req, reply) => {
    const period = parsePeriod((req.params as { period: string }).period);
    const msg = (req.query as Record<string, string>).msg;
    if (!period) return redirect(reply, '/budgets', 'Неверный период бюджета');
    const seg = periodOf(period.month, period.year);

    // Общий список обеих команд: собираем начисления и помечаем командой.
    const monthBudgets = await monthBudgetsOf(period.month, period.year);
    if (monthBudgets.length === 0) return redirect(reply, '/budgets', 'Бюджет не найден');
    const combined: (Charge & { team: Team })[] = [];
    for (const b of monthBudgets) {
      for (const c of await getCharges(b.id)) combined.push({ ...c, team: b.team });
    }
    // Сортировка и отображение — в формате «Имя Отчество Фамилия» (как в сообщении в чат).
    combined.sort((a, b) => formatFullName(a.name).localeCompare(formatFullName(b.name), 'ru'));

    const total = combined.reduce((s, c) => s + Number(c.amount), 0);
    const paidSum = combined.filter((c) => c.paid).reduce((s, c) => s + Number(c.amount), 0);
    const paidCount = combined.filter((c) => c.paid).length;
    const anySent = monthBudgets.some((b) => b.message_id);

    // Последняя отметка «Перевёл» = максимальный paid_at среди оплативших.
    const lastPaidMs = combined
      .filter((c) => c.paid && c.paid_at)
      .reduce((m, c) => Math.max(m, new Date(c.paid_at as string | Date).getTime()), 0);
    const lastCheck = lastPaidMs ? fmtDateTime(new Date(lastPaidMs)) : '';

    const rows = combined
      .map(
        (c) => `<tr>
        <td>${esc(formatFullName(c.name))}</td>
        <td>${teamBadge(c.team)}</td>
        <td class="muted">${esc(c.tg_login)}</td>
        <td>${esc(c.base_amount)}₽</td>
        <td>${c.game_amount ? '+' + esc(c.game_amount) + '₽' : ''}</td>
        <td><b>${esc(c.amount)}₽</b></td>
        <td>${c.paid ? activeBadge(true) : activeBadge(false)}</td>
        <td class="right"><form class="inline" method="post" action="/charges/${c.id}/pay">
          <input type="hidden" name="value" value="${c.paid ? 'no' : 'yes'}">
          <button class="${c.paid ? 'ghost' : 'ok'}">${c.paid ? 'Снять' : 'Перевёл'}</button>
        </form></td></tr>`,
      )
      .join('');

    const body = `<h1>Бюджет ${esc(monthLabel(period.month, period.year))}</h1>
      <div class="card row" style="align-items:center">
        <form class="inline" method="post" action="/budgets/${seg}/send"><button>${anySent ? 'Переотправить сбор' : 'Отправить сбор в чат'}</button></form>
        <form class="inline" method="post" action="/budgets/${seg}/debtors"><button class="ghost">Напомнить должникам</button></form>
        <span class="muted" style="margin-left:auto">Сдали ${paidCount} из ${combined.length}${lastCheck ? ` · последняя проверка: ${esc(lastCheck)}` : ''}</span>
      </div>
      <div class="card">${progressBar(paidSum, total)}</div>
      <div class="card"><table class="pay-table">
        <thead><tr><th>ФИО</th><th>Команда</th><th>tg</th><th>База</th><th>Игры</th><th>Итого</th><th>Оплата</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">Нет начислений</td></tr>'}</tbody></table></div>`;
    return html(reply, layout(`Бюджет ${monthLabel(period.month, period.year)}`, body, { flash: msg }));
  });

  // Переотправить сбор в чаты обеих команд (за месяц бюджета).
  app.post('/budgets/:period/send', async (req, reply) => {
    const period = parsePeriod((req.params as { period: string }).period);
    if (!period) return redirect(reply, '/budgets', 'Неверный период бюджета');
    const seg = periodOf(period.month, period.year);
    try {
      let sent = 0;
      for (const b of await monthBudgetsOf(period.month, period.year)) {
        await sendBudgetToChat(api, b.id);
        sent++;
      }
      return redirect(reply, `/budgets/${seg}`, `Сбор отправлен в чаты (команд: ${sent})`);
    } catch (err) {
      return redirect(reply, `/budgets/${seg}`, `Ошибка: ${(err as Error).message}`);
    }
  });

  // Напомнить должникам в чатах обеих команд (за месяц бюджета).
  app.post('/budgets/:period/debtors', async (req, reply) => {
    const period = parsePeriod((req.params as { period: string }).period);
    if (!period) return redirect(reply, '/budgets', 'Неверный период бюджета');
    const seg = periodOf(period.month, period.year);
    try {
      let count = 0;
      for (const b of await monthBudgetsOf(period.month, period.year)) {
        count += (await sendDebtors(api, b.id)).count;
      }
      return redirect(reply, `/budgets/${seg}`, count ? `Напоминание отправлено (должников: ${count})` : 'Должников нет');
    } catch (err) {
      return redirect(reply, `/budgets/${seg}`, `Ошибка: ${(err as Error).message}`);
    }
  });

  app.post('/charges/:id/pay', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const value = (req.body as { value?: string }).value === 'yes';
    const charge = await setChargePaid(id, value);
    if (!charge) return redirect(reply, '/budgets', 'Оплата обновлена');
    await refreshBudgetMessage(api, charge.budget_id).catch(() => undefined);
    const budget = await getBudgetById(charge.budget_id);
    const back = budget ? `/budgets/${periodOf(budget.month, budget.year)}` : '/budgets';
    return redirect(reply, back, 'Оплата обновлена');
  });

  // ── Игры (учёт взносов; кросс-командно по участникам) ─────
  // Пересобрать бюджеты обеих команд за месяц по обновлённому пулу игр,
  // сохранив статус оплат, и обновить отправленное в чат сообщение (если было).
  const recalcMonthBudgets = async (month: number, year: number): Promise<void> => {
    for (const b of await monthBudgetsOf(month, year)) {
      await recalcBudget(b.id);
      await refreshBudgetMessage(api, b.id).catch(() => undefined);
    }
  };

  const gamesQuery = (month: number, year: number) => `/games?month=${month}&year=${year}`;

  app.get('/games', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const msg = q.msg;
    const def = defaultBudgetPeriod();
    const month = Number(q.month) >= 1 && Number(q.month) <= 12 ? Number(q.month) : def.month;
    const year = Number(q.year) >= 2024 ? Number(q.year) : def.year;

    const games = await listAllGamesForMonth(month, year);
    const flagBtn = (g: (typeof games)[number], flag: 'coach' | 'judge') => {
      const on = flag === 'coach' ? g.coach_present : g.judge;
      const nextCoach = flag === 'coach' ? !g.coach_present : g.coach_present;
      const nextJudge = flag === 'judge' ? !g.judge : g.judge;
      const label = flag === 'coach' ? (on ? 'тренер был' : 'без тренера') : on ? 'судья был' : 'без судьи';
      return `<form class="inline" method="post" action="/games/${g.id}/flags">
        <input type="hidden" name="coach_present" value="${nextCoach ? 'yes' : 'no'}">
        <input type="hidden" name="judge" value="${nextJudge ? 'yes' : 'no'}">
        <button class="${on ? 'ok' : 'ghost'}">${label}</button></form>`;
    };
    const rows = games
      .map((g) => {
        const played = g.participants?.length ?? 0;
        return `<tr>
          <td>${esc(isoToRu(g.played_on))}</td>
          <td>${g.team === 'MIXED' ? '<span class="badge black">MIXED</span>' : teamBadge(g.team)}</td>
          <td>${esc(g.opponent ?? '')}</td>
          <td>${played}</td>
          <td>${g.fee_per_player ? '+' + esc(g.fee_per_player) + '₽' : '—'}</td>
          <td>${flagBtn(g, 'coach')}</td>
          <td>${flagBtn(g, 'judge')}</td>
          <td class="right"><form class="inline" method="post" action="/games/${g.id}/delete" onsubmit="return confirm('Удалить игру и пересчитать бюджеты?')">
            <button class="ghost">Удалить</button></form></td></tr>`;
      })
      .join('');

    const addForm = `<div class="card"><h2>Добавить игру вручную</h2>
      <div class="muted" style="margin-bottom:8px">Основной путь для игр BLACK (МЛБЛ) и товарищеских: стат-сайт МЛБЛ не парсится.
        Состав — список tg-логинов сыгравших (через пробел или запятую), кросс-командно; взнос падает каждому в бюджет его команды.</div>
      <form method="post" action="/games/add">
        <div class="row">
          <div style="flex:0"><label>Команда (метка)</label>
            <select name="team"><option value="BLACK">BLACK</option><option value="RED">RED</option><option value="MIXED">MIXED</option></select></div>
          <div><label>Соперник</label><input name="opponent" placeholder="например, Соколы"></div>
          <div style="flex:0"><label>Дата</label><input name="date" type="date"></div>
        </div>
        <div style="margin-top:8px"><label>Сыгравшие (@login через пробел/запятую)</label>
          <input name="logins" placeholder="@ivanov @petrov sidorov" required></div>
        <div class="row" style="margin-top:8px;align-items:center">
          <label class="inline" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="coach" value="yes" checked style="width:auto"> тренер был</label>
          <label class="inline" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="judge" value="yes" style="width:auto"> был судья</label>
          <div style="flex:0"><button>Добавить игру</button></div>
        </div>
      </form></div>`;

    const body = `<h1>Игры <span class="muted">${esc(monthLabel(month, year))}</span></h1>
      <div class="card"><form method="get" action="/games" class="row">
          <div><label>Месяц</label><input name="month" type="number" min="1" max="12" value="${month}" required></div>
          <div><label>Год</label><input name="year" type="number" min="2024" max="2100" value="${year}" required></div>
          <div style="flex:0"><label>&nbsp;</label><button class="ghost">Показать</button></div>
        </form></div>
      ${addForm}
      <div class="card"><table class="games-table">
        <thead><tr><th>Дата</th><th>Команда</th><th>Соперник</th><th>Сыграло</th><th>Взнос</th><th>Тренер</th><th>Судья</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">Игр за этот месяц нет</td></tr>'}</tbody></table></div>`;
    return html(reply, layout(`Игры ${monthLabel(month, year)}`, body, { flash: msg }));
  });

  app.post('/games/add', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const teamRaw = b.team;
    const team = teamRaw === 'RED' || teamRaw === 'BLACK' || teamRaw === 'MIXED' ? teamRaw : 'BLACK';
    const logins = (b.logins ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (logins.length === 0) return redirect(reply, '/games', 'Укажи хотя бы одного сыгравшего');
    const date = (b.date ?? '').trim() || null;
    // Месяц бюджета берём из даты игры; без даты — период по умолчанию (как в /budgets).
    const my = date
      ? { month: new Date(date).getMonth() + 1, year: new Date(date).getFullYear() }
      : defaultBudgetPeriod();
    const res = await registerManualGame(
      { team, opponent: (b.opponent ?? '').trim() || null, date, logins, coach: b.coach === 'yes', judge: b.judge === 'yes' },
      my.month,
      my.year,
    );
    await recalcMonthBudgets(my.month, my.year);
    const note =
      res.matched === 0
        ? 'Игра не добавлена: ни один логин не найден в базе'
        : `Игра добавлена: сыграло ${res.matched}, взнос ${res.fee}₽` +
          (res.unmatched.length ? ` · не найдены: ${res.unmatched.join(', ')}` : '');
    return redirect(reply, gamesQuery(my.month, my.year), note);
  });

  app.post('/games/:id/flags', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = req.body as Record<string, string>;
    const res = await recomputeGameFee(id, { coach_present: b.coach_present === 'yes', judge: b.judge === 'yes' });
    if (!res || res.month == null || res.year == null) return redirect(reply, '/games', 'Игра не найдена');
    await recalcMonthBudgets(res.month, res.year);
    return redirect(reply, gamesQuery(res.month, res.year), 'Взнос пересчитан, бюджеты обновлены');
  });

  app.post('/games/:id/delete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const game = await deleteGameById(id);
    if (!game || game.month == null || game.year == null) return redirect(reply, '/games', 'Игра удалена');
    await recalcMonthBudgets(game.month, game.year);
    return redirect(reply, gamesQuery(game.month, game.year), 'Игра удалена, бюджеты обновлены');
  });

  // ── Misc actions ─────────────────────────────────────────
  app.post('/polls/run/:kind', async (req, reply) => {
    const kind = (req.params as { kind: string }).kind === 'game' ? 'game' : 'training';
    const label = kind === 'game' ? 'на игры' : 'на тренировки';
    try {
      const { sent, forwarded } = await sendWeeklyPolls(api, kind);
      return redirect(reply, '/', `Опросы ${label} отправлены: ${sent}, переслано: ${forwarded}`);
    } catch (err) {
      return redirect(reply, '/', `Ошибка: ${(err as Error).message}`);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    log.error('[http] ошибка маршрута', err.message);
    reply.status(500).type('text/html').send(layout('Ошибка', `<div class="card">Внутренняя ошибка: ${esc(err.message)}</div>`));
  });

  return app;
}
