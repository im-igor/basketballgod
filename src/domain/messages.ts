import type { BudgetDetails, ExtraFeeItem, Tariffs, Team } from '../db/types.js';
import { gameStatsRef } from '../gamefee/parser.js';
import { monthLabel } from './dates.js';
import { usesSharedCoach } from './budget.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Хранимое «Фамилия Имя Отчество» → «Имя Отчество Фамилия» (фамилия в конце). */
export function formatFullName(name: string | null): string {
  const t = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (t.length >= 2) return `${t.slice(1).join(' ')} ${t[0]}`;
  return name?.trim() ?? '';
}

export function paymentBlock(sberUrl: string, tbankUrl: string): string {
  return `Сбер\n${sberUrl}\n\nТбанк\n${tbankUrl}`;
}

export interface PollDraftView {
  team: Team;
  question: string;
  options: string[];
  is_training: boolean;
  forward: boolean;
  status: 'pending' | 'sent' | 'skipped';
}

/** HTML-карточка черновика опроса в личке у админа (перед публикацией в чат). */
export function buildPollDraftMessage(d: PollDraftView): string {
  const head =
    d.status === 'skipped'
      ? `🗳 <b>${d.team}</b> — <s>пропущен</s>`
      : d.status === 'sent'
        ? `🗳 <b>${d.team}</b> — ✅ отправлен`
        : `🗳 <b>${d.team}</b>`;
  const lines = [
    head,
    `<i>Вопрос:</i> ${escapeHtml(d.question)}`,
    `<i>Варианты:</i> ${d.options.map((o) => escapeHtml(o)).join(' / ')}`,
  ];
  if (d.is_training) {
    const dst = d.team === 'RED' ? 'BLACK' : 'RED';
    lines.push(`<i>Форвард в чат ${dst}:</i> ${d.forward ? 'да' : 'нет'}`);
  }
  return lines.join('\n');
}

export interface ChargeView {
  name: string | null;
  tg_login: string;
  game_amount: number;
  extra_items?: ExtraFeeItem[];
  amount: number;
  paid: boolean;
  /** Только для черновика: результат проверки членства в чате команды. */
  chatStatus?: 'member' | 'left' | 'missing_id' | 'check_error';
}

export interface GameView {
  played_on: string | Date | null; // ISO-строка или Date из БД (колонка date)
  opponent: string | null;
  fee_per_player: number | null;
  stat_url: string | null;
}

export interface BudgetMessageInput {
  team: Team;
  month: number;
  year: number;
  details: BudgetDetails;
  tariffs: Tariffs;
  charges: ChargeView[];
  games: GameView[];
  payment: { sberUrl: string; tbankUrl: string };
}

/** ISO YYYY-MM-DD или Date (колонка date) → ДД.ММ.ГГГГ; пусто, если нет. */
function isoToRu(v: string | Date | null): string {
  if (!v) return '';
  if (v instanceof Date) {
    const d = String(v.getDate()).padStart(2, '0');
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    return `${d}.${mo}.${v.getFullYear()}`;
  }
  const m = v.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Чемпионат определяем по протоколу, а не по команде игрока или игры. */
function gameLeagueLabel(statUrl: string | null): string {
  if (!statUrl) return '';
  try {
    return gameStatsRef(statUrl).source === 'MLBL' ? ' (МЛБЛ)' : ' (ЛЧБ)';
  } catch {
    // Для ручных игр и старых неизвестных ссылок чемпионат не приписываем.
    return '';
  }
}

/**
 * Сообщение сбора в чат команды (HTML parse_mode), формат как в n8n /budget,
 * плюс блок взносов за прошедшие игры и пометки оплат «+».
 */
export function buildBudgetMessage(input: BudgetMessageInput): string {
  const { details: d, tariffs, team } = input;
  const redCount = team === 'RED' ? d.players_team : d.players_other;
  const blackCount = team === 'BLACK' ? d.players_team : d.players_other;
  const label = monthLabel(input.month, input.year);

  // ❗️ пока есть хотя бы один должник; ✅ когда все оплатили.
  const statusIcon = input.charges.some((c) => !c.paid) ? '❗️' : '✅';
  const header = `<b>${statusIcon} Бюджет ${label} ${team}\n\n</b>`;

  // Эффективное число оплат тренера = календарное + ручная дельта; комментарий — после «N трен.».
  const effCoach = Math.max(0, d.coach_sessions + (d.coach_delta ?? 0));
  const coachNote = d.coach_note ? ` ${escapeHtml(d.coach_note)}` : '';
  const sharedSessions = d.coach_shared_sessions;
  const sharedNotes = d.coach_shared_notes;
  const coachLine = usesSharedCoach(input.month, input.year) && sharedSessions
    ? `Тренер Red: ${sharedSessions.RED} трен. + Black: ${sharedSessions.BLACK} трен. = ${sharedSessions.RED + sharedSessions.BLACK} трен.\n` +
      `${sharedSessions.RED + sharedSessions.BLACK} x ${tariffs.coach_per_session} / ${d.total_players} = ${d.coach_per_person} руб.\n` +
      (sharedNotes?.RED ? `Комментарий Red: ${escapeHtml(sharedNotes.RED)}\n` : '') +
      (sharedNotes?.BLACK ? `Комментарий Black: ${escapeHtml(sharedNotes.BLACK)}\n` : '')
    : `Тренер в ${team} ${d.coach_sessions} трен.${coachNote} ${effCoach} x ${tariffs.coach_per_session} / ${d.players_team} = ${d.coach_per_person} руб.\n`;

  // Шкафчик: при нулевой аренде упоминание и слагаемое из формулы убираем.
  const hasLocker = tariffs.locker_rent_price > 0;
  const lockerText = hasLocker ? ` и оплата шкафчика ${tariffs.locker_rent_price}` : '';
  const lockerSum = hasLocker ? ` + ${tariffs.locker_rent_price}` : '';
  const gymFormula = hasLocker
    ? `(${d.paid_gym_sessions} x ${tariffs.gym_paid_price}${lockerSum}) / ${d.total_players}`
    : `${d.paid_gym_sessions} x ${tariffs.gym_paid_price} / ${d.total_players}`;
  const shareWord = hasLocker ? 'делятся' : 'делится';

  const calcInner =
    `Всего участников: ${blackCount} Black + ${redCount} Red = ${d.total_players} чел.\n` +
    `Зал Black по четвергам - ${d.paid_gym_sessions} трен.${lockerText} (${shareWord} на всех)\n` +
    `${gymFormula} = ${d.gym_per_person} руб.\n` +
    `Зал Red по вторникам - оплачивается Яндексом полностью.\n` +
    `${coachLine}\n` +
    `ИТОГО: ${d.base_per_person} руб.\n`;

  // Блок прошедших игр входит в ту же цитату, что и расчёт.
  const gamesInner =
    input.games.length > 0
      ? `\nЗа прошедшие игры прибавляю участвовавшим:\n` +
        input.games
          .map((g) => {
            const date = isoToRu(g.played_on);
            const opp = escapeHtml(g.opponent ?? 'игра');
            return `${date ? `${date} ` : ''}${opp}${gameLeagueLabel(g.stat_url)} +${g.fee_per_player ?? 0}`;
          })
          .join('\n') +
        `\n`
      : '';

  const extraFees = new Map<number, ExtraFeeItem>();
  for (const c of input.charges) {
    for (const item of c.extra_items ?? []) extraFees.set(item.fee_id, item);
  }
  const extraInner = extraFees.size
    ? '\nРазовые взносы (начисляются каждому один раз):\n' +
      [...extraFees.values()].map((item) => `${escapeHtml(item.title)}: +${item.amount} руб./чел.`).join('\n') + '\n'
    : '';
  const quote = `<blockquote>${calcInner}${gamesInner}${extraInner}</blockquote>\n`;

  // В черновике показываем точный результат проверки чата; без проверки — статус оплаты.
  const usersList = input.charges
    .map((c) => {
      const flag = c.chatStatus === 'left' ? '🚫'
        : c.chatStatus === 'missing_id' ? '🟡'
          : c.chatStatus === 'check_error' ? '⚠️'
            : c.paid ? '✅' : '❗️';
      const items = c.extra_items ?? [];
      const extra = items.length
        ? ` (в т.ч. разовые: ${items.map((item) => `${escapeHtml(item.title)} +${item.amount}`).join('; ')})`
        : '';
      return `${flag}${escapeHtml(formatFullName(c.name))} ${c.tg_login} ${c.amount}${extra}`;
    })
    .join('\n');
  const chatLegend = input.charges.some((c) => c.chatStatus && c.chatStatus !== 'member')
    ? '\n\nПроверка чата: 🚫 нет в чате · 🟡 нет Telegram ID · ⚠️ ошибка проверки.'
    : '';

  const pay = paymentBlock(input.payment.sberUrl, input.payment.tbankUrl);
  return `${header}${quote}\n${pay}\n\n${usersList}${chatLegend}`;
}

/** Сообщение-напоминание должникам за месяц. */
export function buildDebtorsMessage(
  monthName: string,
  debtors: { name: string | null; tg_login: string; amount: number }[],
  payment: { sberUrl: string; tbankUrl: string },
): string {
  const pay = paymentBlock(payment.sberUrl, payment.tbankUrl);
  const list = debtors
    .map((c) => `${escapeHtml(formatFullName(c.name))} ${c.tg_login} ${c.amount}`)
    .join('\n');
  return `❗️<b>Должники за ${monthName}, просьба донести взносы</b>\n\n${pay}\n\n${list}`;
}
