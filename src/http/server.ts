import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { webhookCallback, type Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { layout, esc, teamBadge, activeBadge, sortHeader, syncButtons } from './views.js';
import { isoToRu } from '../google/sheets.js';
import { normalizeLogin } from '../util/args.js';
import { computeActivityDates } from '../domain/activity.js';
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
  getBudgetById,
  getCharges,
  setChargePaid,
} from '../db/repos/budgets.repo.js';
import { buildAndSaveBudgets } from '../services/budget.service.js';
import { sendBudgetToChat, refreshBudgetMessage, sendDebtors } from '../services/notify.service.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import {
  syncAllFromSheet,
  syncAllToSheet,
  importPlayersToDb,
  exportPlayersToSheet,
  importTariffsToDb,
  exportTariffsToSheet,
  importCronFromSheet,
  exportCronToSheet,
  importTagsToDb,
  exportTagsToSheet,
} from '../services/sheetSync.service.js';
import { monthLabel } from '../domain/dates.js';
import type { Team, Player } from '../db/types.js';

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
          <form method="post" action="/polls/run"><button>Разослать опросы на неделю</button></form>
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

  // ── Players (источник правды — БД; синк с вкладкой Players по кнопкам) ────
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
        (p) => `<tr>
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
        <div class="muted" style="flex:1">Правки в этом разделе пишутся в БД. Синхронизация с вкладкой
          «Players» Google-таблицы — кнопками справа.</div>
        ${syncButtons('players')}
      </div></div>
      <div class="card"><h2>Добавить / обновить</h2>${playerForm()}</div>
      <div class="card"><table>
        <thead><tr>
          ${sortHeader('ФИО', 'name', '/players', { sort, dir })}
          ${sortHeader('tg', 'tg_login', '/players', { sort, dir })}
          ${sortHeader('Команда', 'team', '/players', { sort, dir })}
          ${sortHeader('Статус', 'active', '/players', { sort, dir })}
          ${sortHeader('С', 'active_from', '/players', { sort, dir })}
          ${sortHeader('По', 'active_to', '/players', { sort, dir })}
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody></table></div>`;
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
    await upsertPlayer({
      name,
      tg_login: tgLogin,
      team: b.team as Team,
      is_employee: b.is_employee === 'yes',
      active: b.active === 'yes',
      active_from: b.active_from ? b.active_from : null,
      active_to: b.active_to ? b.active_to : null,
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

  app.post('/players/pull', syncRoute('/players', importPlayersToDb));
  app.post('/players/push', syncRoute('/players', exportPlayersToSheet));

  // ── Tariffs ──────────────────────────────────────────────
  app.get('/tariffs', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const t = await getTariffs();
    const field = (name: string, label: string, val: number) =>
      `<div><label>${label}</label><input name="${name}" type="number" step="1" value="${val}"></div>`;
    const body = `<h1>Тарифы</h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Правки пишутся в БД. Синхронизация с вкладкой «tariffs» — кнопками справа.</div>
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

  app.post('/tariffs/pull', syncRoute('/tariffs', importTariffsToDb));
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
          Синхронизация с вкладкой «cron» — кнопками справа.</div>
        ${syncButtons('cron')}
      </div></div>
      <div class="card"><form method="post" action="/cron">
        <div class="row">
          ${text('timezone', 'Таймзона', c.timezone, 'Europe/Moscow')}
          ${numf('poll_weekday', 'Опрос: день недели (1=Пн…7=Вс)', c.poll_weekday, '5')}
          ${text('poll_time', 'Опрос: время (ЧЧ:ММ)', c.poll_time, '12:00')}
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
      poll_weekday: int(b.poll_weekday),
      poll_time: str(b.poll_time),
      fixation_day: int(b.fixation_day),
      fixation_time: str(b.fixation_time),
      budget_day: int(b.budget_day),
      budget_time: str(b.budget_time),
    });
    return redirect(reply, '/cron', 'Расписание сохранено');
  });

  app.post('/cron/pull', syncRoute('/cron', importCronFromSheet));
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
          синхронизация с вкладкой «Tags» — кнопками справа. На валидацию парсинга не влияет.</div>
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

  app.post('/tags/pull', syncRoute('/tags', importTagsToDb));
  app.post('/tags/push', syncRoute('/tags', exportTagsToSheet));

  // ── Синхронизация всех вкладок (кнопки в шапке) ──────────
  app.post('/sync/pull', syncRoute('/', syncAllFromSheet));
  app.post('/sync/push', syncRoute('/', syncAllToSheet));

  // ── Budgets ──────────────────────────────────────────────
  app.get('/budgets', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const budgets = await listBudgets();
    const rows = budgets
      .map(
        (b) => `<tr>
        <td><a href="/budgets/${b.id}">${esc(monthLabel(b.month, b.year))}</a></td>
        <td>${teamBadge(b.team)}</td>
        <td>${esc(b.total_per_player ?? '')}₽</td>
        <td>${b.message_id ? '<span class="badge yes">отправлен</span>' : '<span class="badge no">черновик</span>'}</td>
        </tr>`,
      )
      .join('');
    const body = `<h1>Бюджеты</h1>
      <div class="card"><h2>Собрать новый</h2>
        <form method="post" action="/budgets/build" class="row">
          <div><label>Месяц</label><input name="month" type="number" min="1" max="12" required></div>
          <div><label>Год</label><input name="year" type="number" min="2024" max="2100" required></div>
          <div style="flex:0"><label>&nbsp;</label><button>Собрать</button></div>
        </form></div>
      <div class="card"><table>
        <thead><tr><th>Месяц</th><th>Команда</th><th>Базовый</th><th>Статус</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">Пока нет бюджетов</td></tr>'}</tbody>
      </table></div>`;
    return html(reply, layout('Бюджеты', body, { flash: msg }));
  });

  app.post('/budgets/build', async (req, reply) => {
    const b = req.body as { month?: string; year?: string };
    const month = Number(b.month);
    const year = Number(b.year);
    if (!(month >= 1 && month <= 12) || !(year >= 2024)) {
      return redirect(reply, '/budgets', 'Неверный месяц/год');
    }
    await buildAndSaveBudgets(month, year);
    return redirect(reply, '/budgets', `Бюджет за ${monthLabel(month, year)} собран`);
  });

  app.get('/budgets/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const msg = (req.query as Record<string, string>).msg;
    const budget = await getBudgetById(id);
    if (!budget) return redirect(reply, '/budgets', 'Бюджет не найден');
    const charges = await getCharges(id);
    const rows = charges
      .map(
        (c) => `<tr>
        <td>${esc(c.name ?? '')}</td>
        <td class="muted">${esc(c.tg_login)}</td>
        <td>${esc(c.base_amount)}₽</td>
        <td>${c.game_amount ? '+' + esc(c.game_amount) + '₽' : ''}</td>
        <td><b>${esc(c.amount)}₽</b></td>
        <td>${c.paid ? activeBadge(true) : activeBadge(false)}</td>
        <td class="right"><form class="inline" method="post" action="/charges/${c.id}/pay">
          <input type="hidden" name="value" value="${c.paid ? 'no' : 'yes'}">
          <button class="${c.paid ? 'ghost' : 'ok'}">${c.paid ? 'Снять' : 'Оплачено'}</button>
        </form></td></tr>`,
      )
      .join('');
    const paidCount = charges.filter((c) => c.paid).length;
    const body = `<h1>${esc(monthLabel(budget.month, budget.year))} ${teamBadge(budget.team)}</h1>
      <div class="card row">
        <form class="inline" method="post" action="/budgets/${id}/send"><button>${budget.message_id ? 'Переотправить сбор' : 'Отправить сбор в чат'}</button></form>
        <form class="inline" method="post" action="/budgets/${id}/debtors"><button class="ghost">Напомнить должникам</button></form>
        <span class="muted">Оплатили ${paidCount} из ${charges.length}</span>
      </div>
      <div class="card"><table>
        <thead><tr><th>ФИО</th><th>tg</th><th>База</th><th>Игры</th><th>Итого</th><th>Оплата</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    return html(reply, layout(monthLabel(budget.month, budget.year), body, { flash: msg }));
  });

  app.post('/budgets/:id/send', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      await sendBudgetToChat(api, id);
      return redirect(reply, `/budgets/${id}`, 'Сбор отправлен в чат');
    } catch (err) {
      return redirect(reply, `/budgets/${id}`, `Ошибка: ${(err as Error).message}`);
    }
  });

  app.post('/budgets/:id/debtors', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      const { count } = await sendDebtors(api, id);
      return redirect(reply, `/budgets/${id}`, count ? `Напоминание отправлено (${count})` : 'Должников нет');
    } catch (err) {
      return redirect(reply, `/budgets/${id}`, `Ошибка: ${(err as Error).message}`);
    }
  });

  app.post('/charges/:id/pay', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const value = (req.body as { value?: string }).value === 'yes';
    const charge = await setChargePaid(id, value);
    if (charge) await refreshBudgetMessage(api, charge.budget_id).catch(() => undefined);
    const back = charge ? `/budgets/${charge.budget_id}` : '/budgets';
    return redirect(reply, back, 'Оплата обновлена');
  });

  // ── Misc actions ─────────────────────────────────────────
  app.post('/polls/run', async (_req, reply) => {
    try {
      const { sent, forwarded } = await sendWeeklyPolls(api);
      return redirect(reply, '/', `Опросы отправлены: ${sent}, переслано: ${forwarded}`);
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
