import type { Bot, Context } from 'grammy';
import { adminOnly } from '../middlewares/auth.js';
import { normalizeLogin, parseMonthYear, parseBudgetArgs } from '../../util/args.js';
import { computeActivityDates } from '../../domain/activity.js';
import { monthLabel, isoToRu } from '../../domain/dates.js';
import { usesSharedCoach } from '../../domain/budget.js';
import { listPlayers, getByLogin, setActive, linkTelegramUser } from '../../db/repos/players.repo.js';
import { syncAllToSheet } from '../../services/sheetSync.service.js';
import { getBudget } from '../../db/repos/budgets.repo.js';
import { getTariffs } from '../../db/repos/tariffs.repo.js';
import { buildAndSaveBudgets } from '../../services/budget.service.js';
import {
  validateGame,
  registerValidatedGames,
  type GamePlan,
} from '../../services/gameFee.service.js';
import { sendBudgetDraftToAdmins, sendDebtorsDraftToAdmins, refreshBudgetMessage } from '../../services/notify.service.js';
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
/budget RED|BLACK MM YYYY [ссылка [дд.мм.гггг]] … — черновик бюджета команды в личку; ссылки на игры опциональны
/debtors [RED|BLACK] [MM YYYY] — черновик списка должников в личку с кнопкой «Отправить в чат» (без команды — обе; по умолч. текущий месяц)
/pay [MM YYYY] — оплаты кнопками: все игроки обеих команд, ✅ у оплативших, нажатие переключает (по умолч. текущий месяц)
/poll — черновики опросов на неделю в личку (тренировки и игры, каждый со своим горизонтом): правка текста/вариантов/форварда, пропуск и отправка в чат кнопкой

Игры ЛЧБ и МЛБЛ в /budget: ссылки на протоколы парсятся автоматически; сыгравшим считается игрок со временем на площадке > 0. Каждый сыгравший должен быть в ростере (любой команды — кросс-команда разрешена) с active=YES и employee=TRUE. Месяц команды /budget — месяц, в бюджет которого попадёт игра: например, сентябрьский матч указывается при сборе бюджета октября.
Товарищеские и исключения можно завести вручную в админке (раздел «Игры»): состав @login, тумблеры «тренер/судья». Для импортированного матча решение по конфликту тренера берётся из раздела «Расписание». Взнос падает каждому в бюджет его домашней команды.`;

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

  // /budget RED|BLACK MM YYYY [ссылка [дд.мм.гггг]] … — черновик бюджета команды в личку.
  bot.command('budget', adminOnly(safe(async (ctx) => {
    const { value, error } = parseBudgetArgs(argText(ctx));
    if (error || !value) {
      await ctx.reply(error ?? 'Не удалось разобрать аргументы. /budget RED|BLACK MM YYYY [ссылка …]');
      return;
    }
    const { team, month, year, games } = value;
    await ctx.reply(`Считаю бюджет ${team} за ${monthLabel(month, year)}…`);

    // Игры (если есть): сперва валидируем все, и только если без ошибок — сохраняем.
    if (games.length > 0) {
      // Ростер обеих команд: игроки теперь могут играть за чужую команду (кросс-команда),
      // поэтому чужой игрок на стат-странице должен распознаваться, а не падать в ошибку.
      const [roster, tariffs] = await Promise.all([listPlayers(), getTariffs()]);
      const plans: GamePlan[] = [];
      const errors: string[] = [];
      for (const g of games) {
        const res = await validateGame(g.url, team, g.date, roster, tariffs);
        if (res.ok) plans.push(res.plan);
        else errors.push(...res.errors);
      }
      if (errors.length > 0) {
        await ctx.reply(
          `❌ Игры не приняты, бюджет не собран. Исправь указанные ошибки ` +
            `(состав: active=YES и employee=TRUE; конфликты тренера: раздел «Расписание») и повтори:\n\n` +
            errors.map((e) => `• ${e}`).join('\n'),
        );
        return;
      }
      await registerValidatedGames(plans, month, year);
    }

    const built = await buildAndSaveBudgets(month, year, [team]);
    if (usesSharedCoach(month, year)) {
      const failed: Team[] = [];
      for (const affected of TEAMS) {
        const budget = await getBudget(affected, month, year);
        if (budget?.message_id != null && !(await refreshBudgetMessage(ctx.api, budget.id))) failed.push(affected);
      }
      if (failed.length) await ctx.reply(`⚠️ Опубликованные сообщения не обновились: ${failed.join(', ')}`);
    }
    // Инфо-сообщение + сам драфт с кнопкой уходят админам в личку отдельными сообщениями.
    await sendBudgetDraftToAdmins(ctx.api, built);
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
