import type { Bot, Context } from 'grammy';
import { adminOnly } from '../middlewares/auth.js';
import { normalizeLogin, parseMonthYear } from '../../util/args.js';
import { computeActivityDates } from '../../domain/activity.js';
import { monthLabel, isoToRu } from '../../domain/dates.js';
import { getByLogin, setActive, linkTelegramUser } from '../../db/repos/players.repo.js';
import { syncAllToSheet } from '../../services/sheetSync.service.js';
import { getBudget } from '../../db/repos/budgets.repo.js';
import { sendDebtorsDraftToAdmins } from '../../services/notify.service.js';
import { buildPayPrompt } from '../payMark.js';
import { sendPollDraftsToAdmins } from '../pollDraft.js';
import { buildPollDrafts } from '../../services/poll.service.js';
import { log } from '../../util/logger.js';
import type { Team } from '../../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

const HELP = `<b>basketballgod — команды</b>

<b>Игроки (источник правды — БД; состав правится в админке):</b>
/active @login yes|no — активность игрока на след. месяц (пишет в БД)
/sheet — выгрузить БД в Google-таблицу (Players, Tariffs, Cron, Tags) — витрина «показать человеку», обратно не читается

<b>Бюджет и оплаты:</b>
Разовые взносы настраиваются в админке, раздел «Разовые сборы»: с сыгравших или со всех участников бюджета, один раз на человека.
Сборка бюджета, корректировки и публикация доступны в админке, раздел «Расчёт бюджета».
/debtors [RED|BLACK] [MM YYYY] — черновик списка должников в личку с кнопкой «Отправить в чат» (без команды — обе; по умолч. текущий месяц)
/pay [MM YYYY] — оплаты кнопками: все игроки обеих команд, ✅ у оплативших, нажатие переключает (по умолч. текущий месяц)
/poll — черновики опросов на неделю в личку (тренировки и игры, каждый со своим горизонтом): правка текста/вариантов/форварда, пропуск и отправка в чат кнопкой

Игры ЛЧБ и МЛБЛ импортируются в админке (раздел «Игры»). Товарищеские и исключения также заводятся там вручную. Взнос падает каждому в бюджет его домашней команды.`;

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
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP, { parse_mode: 'HTML' });
  });

  bot.command('start', safe(async (ctx) => {
    const username = ctx.from?.username;
    const linked = username && ctx.from?.id
      ? await linkTelegramUser(`@${username}`, ctx.from.id)
      : false;
    const status = ctx.chat?.type === 'private'
      ? linked
        ? '\n\n✅ Ваш Telegram ID привязан к составу. Теперь бот может проверять ваше участие в чате команды.'
        : '\n\nДля проверки участия в чате нужен @username, совпадающий с записью в составе команды.'
      : '';
    await ctx.reply(`${HELP}${status}`, { parse_mode: 'HTML' });
  }));

  // /active @login yes|no — меняет активность в БД (источник правды).
  bot.command('active', adminOnly(safe(async (ctx) => {
    const m = argText(ctx).trim().match(/^(@?[A-Za-z0-9_]+)\s+(yes|no)$/i);
    if (!m) {
      await ctx.reply('Формат: /active @tg_login yes|no');
      return;
    }
    const login = normalizeLogin(m[1]!);
    const active = m[2]!.toLowerCase() === 'yes';
    const existing = await getByLogin(login);
    if (!existing) {
      await ctx.reply(`Игрок ${login} не найден в базе.`);
      return;
    }
    const { active_from, active_to } = computeActivityDates(active);
    // active=yes → active_from = 1-е след. месяца, active_to очищается (см. setActive);
    // active=no → active_to = конец текущего месяца.
    const updated = await setActive(login, active, active_from, active_to);
    if (!updated) {
      await ctx.reply(`Не удалось обновить игрока ${login}.`);
      return;
    }
    await ctx.reply(
      `Изменения применены (в базе):\n` +
        `tg_login: ${updated.tg_login}\n` +
        `active: ${updated.active ? 'YES' : 'NO'}\n` +
        `active_from: ${isoToRu(updated.active_from)}\n` +
        `active_to: ${isoToRu(updated.active_to)}`,
    );
  })));

  // /sheet — выгрузить все вкладки (Players, Tariffs, Cron, Tags) из БД в таблицу
  bot.command('sheet', adminOnly(safe(async (ctx) => {
    await ctx.reply('Выгружаю данные из БД в таблицу…');
    const summary = await syncAllToSheet();
    await ctx.reply(`Готово:\n${summary}`);
  })));

  // /debtors [RED|BLACK] [MM YYYY] — без команды напоминаем обеим.
  bot.command('debtors', adminOnly(safe(async (ctx) => {
    const now = new Date();
    const parts = argText(ctx).trim().split(/\s+/).filter(Boolean);
    // Необязательный первый аргумент — команда (RED|BLACK); остальное — месяц/год.
    let teams = TEAMS;
    if (parts[0] && /^(red|black)$/i.test(parts[0])) {
      teams = [parts.shift()!.toUpperCase() as Team];
    }
    const my = parseMonthYear(parts.join(' '), { month: now.getMonth() + 1, year: now.getFullYear() });
    if (!my) {
      await ctx.reply('Формат: /debtors [RED|BLACK] [MM YYYY]');
      return;
    }
    const report: string[] = [];
    for (const team of teams) {
      const budget = await getBudget(team, my.month, my.year);
      if (!budget) {
        report.push(`${team}: бюджет за ${monthLabel(my.month, my.year)} не найден`);
        continue;
      }
      // Долги — по любому собранному бюджету (черновик или опубликованный).
      // Черновик списка уходит админу в личку с кнопкой «Отправить в чат».
      const res = await sendDebtorsDraftToAdmins(ctx.api, budget.id);
      report.push(
        !res || res.count === 0
          ? `${team}: должников нет`
          : `${team}: черновик отправлен в личку (должников ${res.count})`,
      );
    }
    await ctx.reply(report.join('\n'));
  })));

  // /pay [MM YYYY] — список кнопок с должниками обеих команд; нажатие = отметка оплаты.
  bot.command('pay', adminOnly(safe(async (ctx) => {
    const now = new Date();
    const my = parseMonthYear(argText(ctx), { month: now.getMonth() + 1, year: now.getFullYear() });
    if (!my) {
      await ctx.reply('Формат: /pay [MM YYYY]');
      return;
    }
    const { text, keyboard, hasBudget } = await buildPayPrompt(my.month, my.year);
    if (!hasBudget) {
      await ctx.reply(`Бюджет за ${monthLabel(my.month, my.year)} не найден.`);
      return;
    }
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  })));

  // /poll — собрать черновики опросов на неделю и прислать в личку админам для проверки
  bot.command('poll', adminOnly(safe(async (ctx) => {
    await ctx.reply('Собираю черновики опросов на ближайшую неделю…');
    const drafts = await buildPollDrafts();
    await sendPollDraftsToAdmins(ctx.api, drafts);
    await ctx.reply(`✅ Готово: черновиков — ${drafts.length}. Проверь их в личке и отправь в чат.`);
  })));
}
