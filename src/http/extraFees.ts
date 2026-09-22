import type { FastifyInstance } from 'fastify';
import {
  createExtraFee, deleteUnusedExtraFee, listExtraFeeAllocations, listExtraFees, setExtraFeeActive,
} from '../db/repos/extraFees.repo.js';
import { getBudget } from '../db/repos/budgets.repo.js';
import { extraFeeForm, sumMoney } from '../domain/extraFees.js';
import { monthLabel } from '../domain/dates.js';
import { formatFullName } from '../domain/messages.js';
import { recalcBudget } from '../services/budget.service.js';
import { esc, layout, teamBadge } from './views.js';
import type { Team } from '../db/types.js';

const back = (message: string) => `/extra-fees?msg=${encodeURIComponent(message)}`;
const periodLabel = (period: number) => monthLabel(period % 100, Math.floor(period / 100));

/** Все маршруты защищены общим preHandler авторизации админки. */
export function registerExtraFeeRoutes(app: FastifyInstance): void {
  app.get('/extra-fees', async (req, reply) => {
    const [fees, allocations] = await Promise.all([listExtraFees(), listExtraFeeAllocations()]);
    const nextMonth = new Date();
    nextMonth.setDate(1);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const defaultPeriod = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
    const cards = fees.map((fee) => {
      const assigned = allocations.filter((a) => a.fee_id === fee.id);
      const total = sumMoney(assigned.map((a) => a.amount));
      const paid = sumMoney(assigned.filter((a) => a.paid).map((a) => a.amount));
      const rule = fee.mode === 'PLAYED'
        ? `Сыгравшие · ${fee.league === 'ANY' ? 'все игры' : fee.league} · с ${periodLabel(fee.start_period)}${fee.end_period ? ` по ${periodLabel(fee.end_period)}` : ''}`
        : `Все участники бюджета · ${periodLabel(fee.start_period)}`;
      return `<div class="card">
        <h2>${esc(fee.title)} · ${esc(fee.amount_per_player)} ₽/чел.</h2>
        <p>${fee.team === 'BOTH' ? 'Обе команды' : teamBadge(fee.team)} · ${esc(rule)} · ${fee.active ? 'Активен' : 'Завершён'}</p>
        <p class="muted">Начислено ${assigned.length} чел. / ${esc(total)} ₽. Оплачено в составе бюджетов: ${esc(paid)} ₽.</p>
        <div class="row">
          <form class="inline" method="post" action="/extra-fees/${fee.id}/status">
            <input type="hidden" name="active" value="${fee.active ? 'no' : 'yes'}">
            <button class="ghost">${fee.active ? 'Завершить сбор' : 'Возобновить сбор'}</button>
          </form>
          ${assigned.length === 0 ? `<form class="inline" method="post" action="/extra-fees/${fee.id}/delete" onsubmit="return confirm('Удалить сбор без начислений?')"><button class="danger">Удалить</button></form>` : ''}
        </div>
        ${assigned.length ? `<details style="margin-top:12px"><summary>Кому и в каком месяце начислено</summary>
          <table><thead><tr><th>Игрок</th><th>Бюджет</th><th>Сумма</th><th>Оплата бюджета</th></tr></thead><tbody>
          ${assigned.map((a) => `<tr><td>${esc(formatFullName(a.name) || a.tg_login)}</td>
            <td><a href="/budgets/${String(a.month).padStart(2, '0')}-${a.year}">${esc(monthLabel(a.month, a.year))}</a> ${teamBadge(a.team)}</td>
            <td>${esc(a.amount)} ₽</td><td>${a.paid ? 'Оплачен' : 'Не оплачен'}</td></tr>`).join('')}
          </tbody></table></details>` : ''}
      </div>`;
    }).join('');

    const body = `<h1>Разовые сборы</h1>
      <div class="card muted">Возмещение расходов общака: фиксированная сумма с человека один раз за сбор.
        В режиме «Сыгравшие» взнос попадает в бюджет по мере участия в играх, в режиме «Все участники бюджета» — всем участникам выбранной команды за один месяц.
        Сумма добавляется к обычному взносу. Завершение сбора останавливает новые начисления, сохраняя уже назначенные.</div>
      <div class="card"><h2>Добавить сбор</h2>
        <form method="post" action="/extra-fees">
          <div class="row">
            <div><label for="fee-title">Название</label><input id="fee-title" name="title" maxlength="120" placeholder="Меддопуск МЛБЛ 2026/27" required></div>
            <div><label for="fee-amount">Сумма на человека, ₽</label><input id="fee-amount" name="amount_per_player" type="number" min="0.01" max="9999999999.99" step="0.01" placeholder="380" required></div>
            <div><label for="fee-team">Команда</label><select id="fee-team" name="team"><option>BLACK</option><option>RED</option><option value="BOTH">Обе команды</option></select></div>
          </div>
          <div class="row" style="margin-top:12px">
            <div><label for="fee-mode">С кого собирать</label><select id="fee-mode" name="mode"><option value="PLAYED">Сыгравшие</option><option value="BUDGET">Все участники бюджета</option></select></div>
            <div><label for="fee-league">Игры для сбора</label><select id="fee-league" name="league"><option value="MLBL">МЛБЛ</option><option value="LCHB">ЛЧБ</option><option value="ANY">Все игры, включая ручные</option></select></div>
            <div><label for="fee-start">Первый / единственный месяц бюджета</label><input id="fee-start" name="start_period" type="month" min="2024-01" max="2100-12" value="${defaultPeriod}" required></div>
            <div><label for="fee-end">Последний месяц (необязательно, для сыгравших)</label><input id="fee-end" name="end_period" type="month" min="2024-01" max="2100-12"></div>
          </div>
          <p class="muted">Месяцы относятся к бюджету, в который включены игры. Например, сентябрьские игры в бюджете октября → первый месяц октябрь.
            МЛБЛ и ЛЧБ определяются по импортированному протоколу. Для ручных игр MIXED выбери «Все игры» и «Обе команды».
            В режиме «Сыгравшие» команда относится к игре; сыгравший за BLACK игрок RED получит взнос в бюджет RED.
            В режиме «Все участники бюджета» лига и последний месяц не учитываются.</p>
          <button>Добавить сбор</button>
        </form>
      </div>
      <div class="card"><h2>Применить к готовому бюджету</h2>
        <p class="muted">Новые сборы учитываются при <a href="/budgets">сборке бюджета</a>. Уже собранный бюджет можно пересчитать здесь.
          Пересчитывай месяцы по порядку: разовое начисление закрепляется за первым рассчитанным подходящим бюджетом.
          Проверь итоговые суммы перед публикацией и отметки ранее внесённых оплат.</p>
        <form class="row" method="post" action="/extra-fees/recalculate">
          <div><label for="recalc-period">Месяц бюджета</label><input id="recalc-period" type="month" name="period" min="2024-01" max="2100-12" value="${defaultPeriod}" required></div>
          <div><button class="ghost">Пересчитать обе команды</button></div>
        </form>
      </div>
      ${cards || '<div class="card muted">Разовых сборов пока нет.</div>'}`;
    return reply.type('text/html; charset=utf-8').send(layout('Разовые сборы', body, {
      flash: (req.query as Record<string, string>).msg,
    }));
  });

  app.post('/extra-fees', async (req, reply) => {
    const parsed = extraFeeForm.safeParse(req.body);
    if (!parsed.success) return reply.redirect(back('Проверь название, положительную сумму и период сбора. ' + parsed.error.issues.map((i) => i.message).join('; ')));
    await createExtraFee(parsed.data);
    return reply.redirect(back('Сбор добавлен. Собери или пересчитай нужный бюджет, чтобы включить начисления.'));
  });

  app.post('/extra-fees/:id/status', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const value = (req.body as { active?: string }).active;
    if (!Number.isSafeInteger(id) || id <= 0 || !['yes', 'no'].includes(value ?? '')) return reply.code(400).send('Неверные параметры');
    await setExtraFeeActive(id, value === 'yes');
    return reply.redirect(back(value === 'yes' ? 'Сбор возобновлён.' : 'Сбор завершён. Уже назначенные взносы сохранены.'));
  });

  app.post('/extra-fees/:id/delete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send('Неверный сбор');
    const deleted = await deleteUnusedExtraFee(id);
    return reply.redirect(back(deleted ? 'Сбор удалён.' : 'Сбор уже имеет начисления или не найден. Заверши его, чтобы остановить новые взносы.'));
  });

  app.post('/extra-fees/recalculate', async (req, reply) => {
    const raw = (req.body as { period?: string }).period ?? '';
    if (!/^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/.test(raw) || raw < '2024-01') return reply.code(400).send('Неверный месяц');
    const [year, month] = raw.split('-').map(Number) as [number, number];
    let count = 0;
    for (const team of ['RED', 'BLACK'] as Team[]) {
      const budget = await getBudget(team, month, year);
      if (budget && await recalcBudget(budget.id)) count++;
    }
    return reply.redirect(count
      ? `/budgets?month=${month}&year=${year}&msg=${encodeURIComponent('Бюджеты пересчитаны. Проверь черновики перед публикацией.')}`
      : back('Бюджетов за этот месяц нет. Сначала собери их в разделе «Бюджеты».'));
  });
}
