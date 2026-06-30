import type { Bot, Context } from 'grammy';
import { adminOnly } from '../middlewares/auth.js';
import { normalizeLogin, parseMonthYear, parseBudgetArgs } from '../../util/args.js';
import { computeActivityDates } from '../../domain/activity.js';
import { monthLabel } from '../../domain/dates.js';
import { listPlayers } from '../../db/repos/players.repo.js';
import {
  findPlayerInSheet,
  upsertPlayerInSheet,
  deletePlayerFromSheet,
  ruDateToISO,
  isoToRu,
  type SheetPlayer,
} from '../../google/sheets.js';
import { importPlayersFromSheet } from '../../services/playersImport.service.js';
import { getBudget } from '../../db/repos/budgets.repo.js';
import { getTariffs } from '../../db/repos/tariffs.repo.js';
import { buildAndSaveBudgets } from '../../services/budget.service.js';
import {
  validateGame,
  registerValidatedGames,
  type GamePlan,
} from '../../services/gameFee.service.js';
import { sendBudgetDraftToAdmins, sendDebtors } from '../../services/notify.service.js';
import { buildPayPrompt } from '../payMark.js';
import { sendPollDraftsToAdmins } from '../pollDraft.js';
import { buildPollDrafts } from '../../services/poll.service.js';
import { log } from '../../util/logger.js';
import type { Team } from '../../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

const HELP = `<b>basketballgod — команды</b>

<b>Игроки (правят Google-таблицу — источник правды):</b>
/player_add Имя | @login | RED|BLACK — добавить игрока
/player_set @login поле=значение … — изменить поля (name, team, employee, active, from, to, notes)
/player_del @login — удалить игрока из таблицы
/active @login yes|no — активность игрока на след. месяц
/sync_players — загрузить таблицу в БД (импорт)

<b>Бюджет и оплаты:</b>
/budget RED|BLACK MM YYYY [ссылка [дд.мм.гггг]] … — черновик бюджета команды в личку; ссылки на игры опциональны
/debtors [MM YYYY] — напомнить должникам (по умолчанию текущий месяц)
/pay [MM YYYY] — отметить оплаты кнопками (должники обеих команд, по умолчанию текущий месяц)
/poll — черновики опросов на неделю в личку: правка текста/вариантов/форварда, пропуск и отправка в чат кнопкой

Игры в /budget: каждый сыгравший должен быть в ростере указанной команды с active=YES и employee=TRUE, иначе игра не принимается.`;

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

type PlayerFields = Partial<
  Pick<SheetPlayer, 'name' | 'team' | 'is_employee' | 'active' | 'active_from' | 'active_to' | 'notes'>
>;

/** Разбор `поле=значение …` из /player_set (значения могут содержать пробелы). */
function parsePlayerFields(s: string): { fields: PlayerFields; error?: string } {
  const fields: PlayerFields = {};
  const re = /(\w+)=(.*?)(?=\s+\w+=|$)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    switch (key) {
      case 'name':
        fields.name = val;
        break;
      case 'team': {
        const t = val.toUpperCase();
        if (t !== 'RED' && t !== 'BLACK') return { fields, error: 'team должно быть RED или BLACK' };
        fields.team = t as Team;
        break;
      }
      case 'employee':
        fields.is_employee = /^(yes|true|1|да)$/i.test(val);
        break;
      case 'active':
        fields.active = /^(yes|true|1|да)$/i.test(val);
        break;
      case 'from': {
        const iso = ruDateToISO(val);
        if (!iso) return { fields, error: 'from: формат даты дд.мм.гггг' };
        fields.active_from = iso;
        break;
      }
      case 'to': {
        const iso = ruDateToISO(val);
        if (!iso) return { fields, error: 'to: формат даты дд.мм.гггг' };
        fields.active_to = iso;
        break;
      }
      case 'notes':
        fields.notes = val || null;
        break;
      default:
        break; // неизвестные ключи игнорируем
    }
  }
  return { fields };
}

export function registerCommands(bot: Bot): void {
  bot.command(['help', 'start'], async (ctx) => {
    await ctx.reply(HELP, { parse_mode: 'HTML' });
  });

  // /player_add Имя | @login | RED|BLACK — добавить игрока в таблицу
  bot.command('player_add', adminOnly(safe(async (ctx) => {
    const [name, loginRaw, teamRaw] = argText(ctx).split('|').map((s) => s.trim());
    const team = (teamRaw ?? '').toUpperCase();
    if (!name || !loginRaw || (team !== 'RED' && team !== 'BLACK')) {
      await ctx.reply('Формат: /player_add Имя Фамилия | @login | RED|BLACK');
      return;
    }
    const login = normalizeLogin(loginRaw);
    const existed = await findPlayerInSheet(login);
    await upsertPlayerInSheet(login, { tg_login: login, name, team: team as Team, active: true });
    await ctx.reply(
      `${existed ? '♻️ Обновлён' : '✅ Добавлен'} игрок ${name} (${login}, ${team}) в таблице.`,
    );
  })));

  // /player_set @login поле=значение …
  bot.command('player_set', adminOnly(safe(async (ctx) => {
    const m = argText(ctx).trim().match(/^(@?[A-Za-z0-9_]+)\s+([\s\S]+)$/);
    if (!m) {
      await ctx.reply(
        'Формат: /player_set @login поле=значение …\n' +
          'Поля: name, team=RED|BLACK, employee=yes|no, active=yes|no, from=дд.мм.гггг, to=дд.мм.гггг, notes',
      );
      return;
    }
    const login = normalizeLogin(m[1]!);
    const existing = await findPlayerInSheet(login);
    if (!existing) {
      await ctx.reply(`Игрок ${login} не найден в таблице.`);
      return;
    }
    const { fields, error } = parsePlayerFields(m[2]!);
    if (error) {
      await ctx.reply(`⚠️ ${error}`);
      return;
    }
    if (Object.keys(fields).length === 0) {
      await ctx.reply('Не указано ни одного поля для изменения.');
      return;
    }
    const updated = await upsertPlayerInSheet(login, { tg_login: login, ...fields });
    await ctx.reply(
      `✅ Обновлено в таблице:\n` +
        `name: ${updated.name}\n` +
        `tg_login: ${updated.tg_login}\n` +
        `team: ${updated.team}\n` +
        `employee: ${updated.is_employee ? 'YES' : 'NO'}\n` +
        `active: ${updated.active ? 'YES' : 'NO'}\n` +
        `active_from: ${isoToRu(updated.active_from)}\n` +
        `active_to: ${isoToRu(updated.active_to)}\n` +
        `notes: ${updated.notes ?? ''}`,
    );
  })));

  // /player_del @login
  bot.command('player_del', adminOnly(safe(async (ctx) => {
    const raw = argText(ctx).trim();
    if (!raw) {
      await ctx.reply('Формат: /player_del @login');
      return;
    }
    const login = normalizeLogin(raw);
    const ok = await deletePlayerFromSheet(login);
    await ctx.reply(
      ok ? `🗑️ Игрок ${login} удалён из таблицы.` : `Игрок ${login} не найден в таблице.`,
    );
  })));

  // /active @login yes|no — пишет в таблицу
  bot.command('active', adminOnly(safe(async (ctx) => {
    const m = argText(ctx).trim().match(/^(@?[A-Za-z0-9_]+)\s+(yes|no)$/i);
    if (!m) {
      await ctx.reply('Формат: /active @tg_login yes|no');
      return;
    }
    const login = normalizeLogin(m[1]!);
    const active = m[2]!.toLowerCase() === 'yes';
    const existing = await findPlayerInSheet(login);
    if (!existing) {
      await ctx.reply(`Игрок ${login} не найден в таблице.`);
      return;
    }
    const { active_from, active_to } = computeActivityDates(active);
    // active=yes → задаём active_from (active_to не трогаем); active=no → задаём active_to.
    const updated = await upsertPlayerInSheet(login, {
      tg_login: login,
      active,
      ...(active ? { active_from } : { active_to }),
    });
    await ctx.reply(
      `Изменения применены (в таблице):\n` +
        `tg_login: ${updated.tg_login}\n` +
        `active: ${updated.active ? 'YES' : 'NO'}\n` +
        `active_from: ${isoToRu(updated.active_from)}\n` +
        `active_to: ${isoToRu(updated.active_to)}`,
    );
  })));

  // /sync_players — импорт таблицы в БД
  bot.command('sync_players', adminOnly(safe(async (ctx) => {
    await ctx.reply('Импортирую игроков из таблицы в БД…');
    const { imported, deactivated } = await importPlayersFromSheet();
    await ctx.reply(`✅ Импорт завершён. Обновлено: ${imported}, деактивировано: ${deactivated}.`);
  })));

  // /budget RED|BLACK MM YYYY [ссылка [дд.мм.гггг]] … — черновик бюджета команды в личку.
  bot.command('budget', adminOnly(safe(async (ctx) => {
    const { value, error } = parseBudgetArgs(argText(ctx));
    if (error || !value) {
      await ctx.reply(error ?? 'Не удалось разобрать аргументы. /budget RED|BLACK MM YYYY [ссылка …]');
      return;
    }
    const { team, month, year, games } = value;
    await ctx.reply(
      `Импортирую игроков из таблицы и считаю бюджет ${team} за ${monthLabel(month, year)}…`,
    );
    await importPlayersFromSheet();

    // Игры (если есть): сперва валидируем все, и только если без ошибок — сохраняем.
    if (games.length > 0) {
      const [roster, tariffs] = await Promise.all([listPlayers(team), getTariffs()]);
      const plans: GamePlan[] = [];
      const errors: string[] = [];
      for (const g of games) {
        const res = await validateGame(g.url, team, g.date, roster, tariffs);
        if (res.ok) plans.push(res.plan);
        else errors.push(...res.errors);
      }
      if (errors.length > 0) {
        await ctx.reply(
          `❌ Игры не приняты, бюджет не собран. Исправь состав в таблице (active=YES, ` +
            `employee=TRUE, верная команда) и повтори:\n\n` +
            errors.map((e) => `• ${e}`).join('\n'),
        );
        return;
      }
      await registerValidatedGames(plans, month, year);
    }

    const built = await buildAndSaveBudgets(month, year, [team]);
    // Инфо-сообщение + сам драфт с кнопкой уходят админам в личку отдельными сообщениями.
    await sendBudgetDraftToAdmins(ctx.api, built);
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
