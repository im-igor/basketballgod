import type { Bot } from 'grammy';
import { isAdmin } from './middlewares/auth.js';
import { sendDebtors } from '../services/notify.service.js';
import { log } from '../util/logger.js';

/**
 * Обработчик кнопки «Отправить в чат» под черновиком списка должников.
 * callback_data: `debtorssend:<budgetId>`. После нажатия бот постит напоминание
 * должникам в чат команды (долги пересчитываются на момент нажатия).
 */
export function registerDebtorsPublish(bot: Bot): void {
  bot.callbackQuery(/^debtorssend:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const budgetId = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const { count } = await sendDebtors(ctx.api, budgetId);
      await ctx.answerCallbackQuery({ text: count ? `✅ Отправлено (${count})` : 'Должников нет' });
      // Убираем кнопку, чтобы не отправить повторно случайно.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.reply(
        count
          ? `✅ Напоминание должникам отправлено в чат (${count}).`
          : 'Должников нет — ничего не отправлено.',
      );
    } catch (err) {
      log.error('[debtors-publish] ошибка', (err as Error).message);
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });
}
