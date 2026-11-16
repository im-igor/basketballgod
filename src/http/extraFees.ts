import type { FastifyInstance } from 'fastify';
import {
  createExtraFee, deleteUnusedExtraFee, listExtraFeeAllocations, listExtraFees, setExtraFeeActive,
  updateExtraFeeRule,
} from '../db/repos/extraFees.repo.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getBudget } from '../db/repos/budgets.repo.js';
import { extraFeeForm, extraFeeRuleForm, sumMoney } from '../domain/extraFees.js';
import { monthLabel } from '../domain/dates.js';
import { usesCommonBudget } from '../domain/budget.js';
import { formatFullName } from '../domain/messages.js';
import { recalcBudget } from '../services/budget.service.js';
import { esc, layout, teamBadge } from './views.js';

const back = (message: string) => `/extra-fees?msg=${encodeURIComponent(message)}`;
const periodLabel = (period: number) => monthLabel(period % 100, Math.floor(period / 100));

const recipientScript = `<script>
document.querySelectorAll('[data-recipient-picker]').forEach(function(picker) {
  var search = picker.querySelector('[data-recipient-search]');
  var list = picker.querySelector('[data-recipient-list]');
  var rows = Array.from(list.querySelectorAll('[data-recipient-row]'));
  var scopes = Array.from(picker.querySelectorAll('input[name="recipient_scope"]'));
  function syncScope() {
    var selected = scopes.some(function(radio) { return radio.checked && radio.value === 'SELECTED'; });
    list.hidden = !selected;
    picker.querySelector('[data-recipient-tools]').hidden = !selected;
    rows.forEach(function(row) { row.querySelector('input[type="checkbox"]').disabled = !selected; });
  }
  function filter() {
    var needle = (search.value || '').trim().toLocaleLowerCase('ru');
    rows.forEach(function(row) { row.hidden = !!needle && !row.dataset.search.includes(needle); });
  }
  scopes.forEach(function(radio) { radio.addEventListener('change', syncScope); });
  search.addEventListener('input', filter);
  picker.querySelector('[data-select-filtered]').addEventListener('click', function() {
    scopes.forEach(function(radio) { radio.checked = radio.value === 'SELECTED'; });
    syncScope(); filter();
    rows.filter(function(row) { return !row.hidden; }).forEach(function(row) { row.querySelector('input[type="checkbox"]').checked = true; });
  });
  picker.querySelector('[data-clear-filtered]').addEventListener('click', function() {
    rows.filter(function(row) { return !row.hidden; }).forEach(function(row) { row.querySelector('input[type="checkbox"]').checked = false; });
  });
  syncScope(); filter();
});
</script>`;

function recipientPicker(players: Awaited<ReturnType<typeof listPlayers>>, selectedIds: number[], scope: 'ALL' | 'SELECTED', key: string): string {
  const selected = new Set(selectedIds);
  const rows = [...players]
    .sort((a, b) => formatFullName(a.name).localeCompare(formatFullName(b.name), 'ru', { sensitivity: 'base' }))
    .map((player) => {
      const name = formatFullName(player.name) || player.tg_login;
      return `<label data-recipient-row data-search="${esc(`${name} ${player.tg_login}`.toLocaleLowerCase('ru'))}" style="display:flex;gap:8px;align-items:center;padding:5px 0">
        <input type="checkbox" name="player_ids" value="${player.id}" ${selected.has(player.id) ? 'checked' : ''}>
        <span>${esc(name)} <span class="muted">${esc(player.tg_login)}</span></span>
      </label>`;
    }).join('');
  return `<fieldset data-recipient-picker style="margin-top:12px;border:1px solid var(--border);border-radius:10px;padding:12px">
    <legend>Кому может быть начислен сбор</legend>
    <div class="recipient-scope">
      <label><input type="radio" name="recipient_scope" value="ALL" ${scope === 'ALL' ? 'checked' : ''}> Всем подходящим игрокам</label>
      <label><input type="radio" name="recipient_scope" value="SELECTED" ${scope === 'SELECTED' ? 'checked' : ''}> Только выбранным</label>
    </div>
    <div data-recipient-tools style="margin-top:10px">
      <label for="recipient-search-${esc(key)}">Поиск по ФИО</label>
      <input id="recipient-search-${esc(key)}" data-recipient-search type="search" placeholder="Начни вводить имя или фамилию">
      <div class="row" style="margin-top:8px;gap:8px">
        <button type="button" class="ghost" data-select-filtered>Выбрать найденных</button>
        <button type="button" class="ghost" data-clear-filtered>Снять найденных</button>
      </div>
    </div>
    <div data-recipient-list style="max-height:280px;overflow:auto;margin-top:8px">${rows}</div>
  </fieldset>`;
}

/** Все маршруты защищены общим preHandler авторизации админки. */
export function registerExtraFeeRoutes(app: FastifyInstance): void {
  app.get('/extra-fees', async (req, reply) => {
    const [fees, allocations, players] = await Promise.all([listExtraFees(), listExtraFeeAllocations(), listPlayers()]);
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
        : fee.mode === 'ACTIVE'
          ? `Активные участники бюджета · с ${periodLabel(fee.start_period)}`
          : `Все участники бюджета · ${periodLabel(fee.start_period)}`;
      const recipients = fee.recipient_scope === 'ALL'
        ? 'все подходящие игроки'
        : `выбрано игроков: ${fee.recipient_player_ids.length}`;
      return `<div class="card">
        <h2>${esc(fee.title)} · ${esc(fee.amount_per_player)} ₽/чел.</h2>
        <p>${fee.team === 'BOTH' ? 'Обе команды' : teamBadge(fee.team)} · ${esc(rule)} · ${esc(recipients)} · ${fee.active ? 'Активен' : 'Завершён'}</p>
        <p class="muted">Начислено ${assigned.length} чел. / ${esc(total)} ₽. Оплачено в составе бюджетов: ${esc(paid)} ₽.</p>
        <details style="margin:12px 0"><summary>Настроить будущие начисления</summary>
          <form method="post" action="/extra-fees/${fee.id}/rule">
            <div class="row" style="margin-top:12px">
              <div><label>Команда игры / заявки</label><select name="team"><option value="BLACK" ${fee.team === 'BLACK' ? 'selected' : ''}>BLACK</option><option value="RED" ${fee.team === 'RED' ? 'selected' : ''}>RED</option><option value="BOTH" ${fee.team === 'BOTH' ? 'selected' : ''}>Обе команды</option></select></div>
              <div><label>Когда начислять</label><select name="mode"><option value="ACTIVE" ${fee.mode === 'ACTIVE' ? 'selected' : ''}>Активным</option><option value="PLAYED" ${fee.mode === 'PLAYED' ? 'selected' : ''}>Фактически сыгравшим</option>${fee.mode === 'BUDGET' ? '<option value="BUDGET" selected>Все участники одного бюджета (старый режим)</option>' : ''}</select></div>
              <div><label>Лига для сыгравших</label><select name="league"><option value="MLBL" ${fee.league === 'MLBL' ? 'selected' : ''}>МЛБЛ</option><option value="LCHB" ${fee.league === 'LCHB' ? 'selected' : ''}>ЛЧБ</option><option value="ANY" ${fee.league === 'ANY' ? 'selected' : ''}>Все игры</option></select></div>
            </div>
            ${recipientPicker(players, fee.recipient_player_ids, fee.recipient_scope, `fee-${fee.id}`)}
            <p class="muted">Изменение влияет только на будущие назначения. Уже начисленные суммы сохраняются.</p>
            <button>Сохранить логику</button>
          </form>
        </details>
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
        Сначала выбирается круг игроков — все либо отмеченные вручную. Затем правило: «Активные» получают взнос в ближайшем бюджете, «Фактически сыгравшие» — только после выхода в матче выбранной лиги.
        Сумма добавляется к обычному взносу. Завершение сбора останавливает новые начисления, сохраняя уже назначенные.</div>
      <div class="card"><h2>Добавить сбор</h2>
        <form method="post" action="/extra-fees">
          <div class="row">
            <div><label for="fee-title">Название</label><input id="fee-title" name="title" maxlength="120" placeholder="Меддопуск МЛБЛ 2026/27" required></div>
            <div><label for="fee-amount">Сумма на человека, ₽</label><input id="fee-amount" name="amount_per_player" type="number" min="0.01" max="9999999999.99" step="0.01" placeholder="380" required></div>
            <div><label for="fee-team">Команда</label><select id="fee-team" name="team"><option>BLACK</option><option>RED</option><option value="BOTH">Обе команды</option></select></div>
          </div>
          <div class="row" style="margin-top:12px">
            <div><label for="fee-mode">Когда начислять</label><select id="fee-mode" name="mode"><option value="ACTIVE">Всем активным</option><option value="PLAYED">Фактически сыгравшим</option></select></div>
            <div><label for="fee-league">Игры для сбора</label><select id="fee-league" name="league"><option value="MLBL">МЛБЛ</option><option value="LCHB">ЛЧБ</option><option value="ANY">Все игры, включая ручные</option></select></div>
            <div><label for="fee-start">Первый / единственный месяц бюджета</label><input id="fee-start" name="start_period" type="month" min="2024-01" max="2100-12" value="${defaultPeriod}" required></div>
            <div><label for="fee-end">Последний месяц (необязательно, для сыгравших)</label><input id="fee-end" name="end_period" type="month" min="2024-01" max="2100-12"></div>
          </div>
          ${recipientPicker(players, [], 'ALL', 'new')}
          <p class="muted">В режиме «Активные участники бюджета» сбор попадёт в первый собранный бюджет игрока, начиная с указанного месяца. Для «Сыгравших» месяцы относятся к бюджету, в который включены игры: например, сентябрьские игры в бюджете октября → первый месяц октябрь.
            МЛБЛ и ЛЧБ определяются по импортированному протоколу. Для ручных игр MIXED выбери «Все игры» и «Обе команды».
            В режиме «Фактически сыгравшие» команда относится к игре; сыгравший за BLACK игрок RED получит взнос в свой общий бюджет.
            Для «Активных» лига и последний месяц не учитываются. Выбор игроков дополнительно ограничивает получателей при любом правиле.</p>
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
      ${cards || '<div class="card muted">Разовых сборов пока нет.</div>'}
      ${recipientScript}`;
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

  app.post('/extra-fees/:id/rule', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send('Неверный сбор');
    const parsed = extraFeeRuleForm.safeParse(req.body);
    if (!parsed.success) return reply.redirect(back('Проверь правило и выбери хотя бы одного игрока для выборочного сбора.'));
    const updated = await updateExtraFeeRule(id, parsed.data);
    return reply.redirect(back(updated
      ? 'Логика будущих начислений обновлена. Уже назначенные суммы сохранены.'
      : 'Сбор не найден.'));
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
    const teams = usesCommonBudget(month, year) ? ['COMMON'] as const : ['RED', 'BLACK'] as const;
    for (const team of teams) {
      const budget = await getBudget(team, month, year);
      if (budget && await recalcBudget(budget.id)) count++;
    }
    return reply.redirect(count
      ? `/budgets?month=${month}&year=${year}&msg=${encodeURIComponent('Бюджеты пересчитаны. Проверь черновики перед публикацией.')}`
      : back('Бюджетов за этот месяц нет. Сначала собери их в разделе «Бюджеты».'));
  });
}
