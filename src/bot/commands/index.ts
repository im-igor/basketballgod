import type { Bot, Context } from 'grammy';
import { adminOnly } from '../middlewares/auth.js';
import { normalizeLogin, parseMonthYear, extractUrls } from '../../util/args.js';
import { computeActivityDates } from '../../domain/activity.js';
import { toRuDate, nextMonthOf, monthLabel } from '../../domain/dates.js';
import { setActive, getByLogin } from '../../db/repos/players.repo.js';
import { getBudget, setChargePaidByLogin } from '../../db/repos/budgets.repo.js';
import { buildAndSaveBudgets } from '../../services/budget.service.js';
import { processGameUrls } from '../../services/gameFee.service.js';
import { sendBudgetToChat, refreshBudgetMessage, sendDebtors } from '../../services/notify.service.js';
import { sendWeeklyPolls } from '../../services/poll.service.js';
import { log } from '../../util/logger.js';
import type { Team } from '../../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

const HELP = `<b>basketballgod — команды</b>

/active @login yes|no — активность игрока на след. месяц
/budget [MM YYYY] — собрать и разослать бюджет (по умолчанию след. месяц)
/game_fee url1 url2 … — посчитать взносы за игру по статистике
/debtors [MM YYYY] — напомнить должникам (по умолчанию текущий месяц)
/pay @login MM YYYY — отметить оплату игрока
/poll — разослать опросы на ближайшую неделю вручную`;

/** Текст аргументов команды (grammY типизирует ctx.match как string | RegExpMatchArray). */
const argText = (ctx: Context): string => (typeof ctx.match === 'string' ? ctx.match : '');

/** Безопасная обёртка: ловим ошибки команды и сообщаем админу. */
function safe(handler: (ctx: Context) => Promise<void>) {
  return async (ctx: Context) => {
    try {
      await handler(ctx);
    } catch (err) {
      log.error('[command] ошибка', (err as Error).message);
      await ctx.reply(`⚠️ Ошибка: ${(err as Error).message}`).catch(() => undefined);
    }
  };
}

export function registerCommands(bot: Bot): void {
  bot.command(['help', 'start'], async (ctx) => {
    await ctx.reply(HELP, { parse_mode: 'HTML' });
  });

  // /active @login yes|no
  bot.command('active', adminOnly(safe(async (ctx) => {
    const m = argText(ctx).trim().match(/^(@?[A-Za-z0-9_]+)\s+(yes|no)$/i);
    if (!m) {
      await ctx.reply('Формат: /active @tg_login yes|no');
      return;
    }
    const login = normalizeLogin(m[1]!);
    const active = m[2]!.toLowerCase() === 'yes';
    const { active_from, active_to } = computeActivityDates(active);
    const player = await setActive(login, active, active_from, active_to);
    if (!player) {
      await ctx.reply(`Игрок ${login} не найден в таблице.`);
      return;
    }
    await ctx.reply(
      `Изменения применены:\n` +
        `tg_login: ${player.tg_login}\n` +
        `active: ${player.active ? 'YES' : 'NO'}\n` +
        `active_from: ${toRuDate(player.active_from)}\n` +
        `active_to: ${toRuDate(player.active_to)}`,
    );
  })));

  // /budget [MM YYYY]
  bot.command('budget', adminOnly(safe(async (ctx) => {
    const my = parseMonthYear(argText(ctx), nextMonthOf(new Date()));
    if (!my) {
      await ctx.reply('Формат: /budget MM YYYY (например /budget 7 2026)');
      return;
    }
    await ctx.reply(`Считаю бюджет за ${monthLabel(my.month, my.year)}…`);
    const built = await buildAndSaveBudgets(my.month, my.year);
    for (const team of TEAMS) {
      await sendBudgetToChat(ctx.api, built[team].budgetId);
    }
    const summary = TEAMS.map(
      (t) => `${t}: ${built[t].result.base_per_person}₽ базовый × ${built[t].result.charges.length} чел.`,
    ).join('\n');
    await ctx.reply(`✅ Бюджет разослан в чаты команд.\n${summary}`);
  })));

  // /game_fee url1 url2 ...
  bot.command('game_fee', adminOnly(safe(async (ctx) => {
    const urls = extractUrls(argText(ctx));
    if (urls.length === 0) {
      await ctx.reply('Формат: /game_fee https://… [https://…]');
      return;
    }
    await ctx.reply(`Обрабатываю игр: ${urls.length}…`);
    const results = await processGameUrls(urls);
    const lines = results.map((r) => {
      const unmatched = r.unmatched.length ? `\n  не сопоставлены: ${r.unmatched.join(', ')}` : '';
      return `🏀 ${r.teamName} [${r.team}] — сыграло ${r.played.length}, взнос ${r.fee_per_player}₽/чел.${unmatched}`;
    });
    await ctx.reply(lines.join('\n\n'));
  })));

  // /debtors [MM YYYY]
  bot.command('debtors', adminOnly(safe(async (ctx) => {
    const now = new Date();
    const my = parseMonthYear(argText(ctx), { month: now.getMonth() + 1, year: now.getFullYear() });
    if (!my) {
      await ctx.reply('Формат: /debtors MM YYYY');
      return;
    }
    const report: string[] = [];
    for (const team of TEAMS) {
      const budget = await getBudget(team, my.month, my.year);
      if (!budget) {
        report.push(`${team}: бюджет за ${monthLabel(my.month, my.year)} не найден`);
        continue;
      }
      const { count } = await sendDebtors(ctx.api, budget.id);
      report.push(`${team}: должников ${count}`);
    }
    await ctx.reply(report.join('\n'));
  })));

  // /pay @login MM YYYY
  bot.command('pay', adminOnly(safe(async (ctx) => {
    const m = argText(ctx).trim().match(/^(@?[A-Za-z0-9_]+)\s+(\d{1,2})\s+(\d{4})$/);
    if (!m) {
      await ctx.reply('Формат: /pay @login MM YYYY');
      return;
    }
    const login = normalizeLogin(m[1]!);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const player = await getByLogin(login);
    if (!player) {
      await ctx.reply(`Игрок ${login} не найден.`);
      return;
    }
    const budget = await getBudget(player.team, month, year);
    if (!budget) {
      await ctx.reply(`Бюджет ${player.team} за ${monthLabel(month, year)} не найден.`);
      return;
    }
    const charge = await setChargePaidByLogin(budget.id, login, true);
    if (!charge) {
      await ctx.reply(`Начисление для ${login} в этом бюджете не найдено.`);
      return;
    }
    await refreshBudgetMessage(ctx.api, budget.id);
    await ctx.reply(`✅ Отмечена оплата ${login} за ${monthLabel(month, year)} (${charge.amount}₽).`);
  })));

  // /poll — ручной запуск рассылки опросов
  bot.command('poll', adminOnly(safe(async (ctx) => {
    await ctx.reply('Рассылаю опросы…');
    const { sent, forwarded } = await sendWeeklyPolls(ctx.api);
    await ctx.reply(`✅ Отправлено опросов: ${sent}, переслано тренировок: ${forwarded}`);
  })));
}
