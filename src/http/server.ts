import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { webhookCallback, type Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { layout, esc, teamBadge, activeBadge } from './views.js';
import {
  readPlayersSheet,
  findPlayerInSheet,
  upsertPlayerInSheet,
  deletePlayerFromSheet,
  isoToRu,
  type SheetPlayer,
} from '../google/sheets.js';
import { importPlayersFromSheet } from '../services/playersImport.service.js';
import { computeActivityDates } from '../domain/activity.js';
import { getTariffs, updateTariffs } from '../db/repos/tariffs.repo.js';
import {
  listBudgets,
  getBudgetById,
  getCharges,
  setChargePaid,
} from '../db/repos/budgets.repo.js';
import { buildAndSaveBudgets } from '../services/budget.service.js';
import { sendBudgetToChat, refreshBudgetMessage, sendDebtors } from '../services/notify.service.js';
import { sendWeeklyPolls } from '../services/poll.service.js';
import { monthLabel } from '../domain/dates.js';
import type { Team } from '../db/types.js';

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

  // ── Players (источник правды — Google-таблица) ───────────
  // Полная форма игрока (добавление/редактирование). Пишет в таблицу.
  const playerForm = (p?: SheetPlayer): string => {
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
        <div><label>Активен с</label><input name="active_from" type="date" value="${esc(p?.active_from ?? '')}"></div>
        <div><label>Активен по</label><input name="active_to" type="date" value="${esc(p?.active_to ?? '')}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div><label>Заметки</label><input name="notes" value="${esc(p?.notes ?? '')}"></div>
        <div style="flex:0"><label>&nbsp;</label><button>Сохранить</button></div>
      </div>
    </form>`;
  };

  app.get('/players', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const players = await readPlayersSheet();
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
          <form class="inline" method="post" action="/players/delete" onsubmit="return confirm('Удалить игрока из таблицы?')">
            <input type="hidden" name="login" value="${esc(p.tg_login)}">
            <button class="ghost">✕</button>
          </form>
        </td></tr>`,
      )
      .join('');

    const body = `<h1>Игроки <span class="muted">(${players.length})</span></h1>
      <div class="card"><div class="row" style="justify-content:space-between;align-items:center">
        <div class="muted" style="flex:1">Источник правды — Google-таблица. Правки здесь пишутся в таблицу.
          Чтобы расчёты (бюджет, должники) увидели изменения — нажми «Импортировать в БД».</div>
        <form class="inline" method="post" action="/players/sync"><button class="ok">Импортировать в БД</button></form>
      </div></div>
      <div class="card"><h2>Добавить / обновить</h2>${playerForm()}</div>
      <div class="card"><table>
        <thead><tr><th>ФИО</th><th>tg</th><th>Команда</th><th>Статус</th><th>С</th><th>По</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    return html(reply, layout('Игроки', body, { flash: msg }));
  });

  app.get('/players/edit', async (req, reply) => {
    const login = (req.query as Record<string, string>).login;
    const player = login ? await findPlayerInSheet(login) : null;
    if (!player) return redirect(reply, '/players', 'Игрок не найден в таблице');
    const body = `<h1>Изменить игрока</h1>
      <div class="card">${playerForm(player)}</div>
      <div class="card"><a href="/players">← к списку игроков</a></div>`;
    return html(reply, layout('Изменить игрока', body));
  });

  app.post('/players', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const name = (b.name ?? '').trim();
    const tgLogin = (b.tg_login ?? '').trim();
    if (!name || !tgLogin || (b.team !== 'RED' && b.team !== 'BLACK')) {
      return redirect(reply, '/players', 'Заполни ФИО, tg_login и команду');
    }
    const origLogin = (b.orig_login ?? '').trim() || null;
    await upsertPlayerInSheet(origLogin, {
      tg_login: tgLogin,
      name,
      team: b.team as Team,
      is_employee: b.is_employee === 'yes',
      active: b.active === 'yes',
      active_from: b.active_from ? b.active_from : null,
      active_to: b.active_to ? b.active_to : null,
      notes: (b.notes ?? '').trim() || null,
    });
    return redirect(reply, '/players', 'Игрок сохранён в таблице');
  });

  app.post('/players/active', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const login = (b.login ?? '').trim();
    const value = b.value === 'yes';
    if (login && (await findPlayerInSheet(login))) {
      const { active_from, active_to } = computeActivityDates(value);
      await upsertPlayerInSheet(login, {
        tg_login: login,
        active: value,
        ...(value ? { active_from } : { active_to }),
      });
    }
    return redirect(reply, '/players', 'Статус обновлён в таблице');
  });

  app.post('/players/delete', async (req, reply) => {
    const login = ((req.body as Record<string, string>).login ?? '').trim();
    if (login) await deletePlayerFromSheet(login);
    return redirect(reply, '/players', 'Игрок удалён из таблицы');
  });

  app.post('/players/sync', async (_req, reply) => {
    try {
      const { imported, deactivated } = await importPlayersFromSheet();
      return redirect(reply, '/players', `Импорт в БД: обновлено ${imported}, деактивировано ${deactivated}`);
    } catch (err) {
      return redirect(reply, '/players', `Ошибка импорта: ${(err as Error).message}`);
    }
  });

  // ── Tariffs ──────────────────────────────────────────────
  app.get('/tariffs', async (req, reply) => {
    const msg = (req.query as Record<string, string>).msg;
    const t = await getTariffs();
    const field = (name: string, label: string, val: number) =>
      `<div><label>${label}</label><input name="${name}" type="number" step="1" value="${val}"></div>`;
    const body = `<h1>Тарифы</h1>
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
