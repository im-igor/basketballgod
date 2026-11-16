import type { Bot, Context } from 'grammy';
import { adminOnly } from '../middlewares/auth.js';
import { normalizeLogin } from '../../util/args.js';
import { computeActivityDates } from '../../domain/activity.js';
import { isoToRu } from '../../domain/dates.js';
import { getByLogin, setActive, linkTelegramUser } from '../../db/repos/players.repo.js';
import { log } from '../../util/logger.js';

const HELP = `<b>basketballgod — команды</b>

<b>Игроки (источник правды — БД; состав правится в админке):</b>
/active @login yes|no — активность игрока на след. месяц (пишет в БД)

<b>Управление:</b>
Состав, таблица, бюджеты, оплаты, должники, игры и голосовалки управляются в админке.`;

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

}
