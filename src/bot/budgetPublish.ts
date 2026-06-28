import type { Bot } from 'grammy';
import { isAdmin } from './middlewares/auth.js';
import { sendBudgetToChat } from '../services/notify.service.js';
import { log } from '../util/logger.js';

/**
 * Обработчик кнопки «Опубликовать в чат» под черновиком бюджета.
 * callback_data: `budpub:<budgetId>`. После нажатия бот сам постит сбор в чат
 * команды (sendBudgetToChat сохраняет message_id → отметки оплат «+» работают).
 */
export function registerBudgetPublish(bot: Bot): void {
  bot.callbackQuery(/^budpub:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const budgetId = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      await sendBudgetToChat(ctx.api, budgetId);
      await ctx.answerCallbackQuery({ text: '✅ Опубликовано в чат команды' });
      // Убираем кнопку, чтобы не опубликовать повторно случайно.
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.reply(`✅ Бюджет #${budgetId} опубликован в чат команды.`);
    } catch (err) {
      log.error('[budget-publish] ошибка', (err as Error).message);
      await ctx.answerCallbackQuery({
        text: `Ошибка: ${(err as Error).message}`,
        show_alert: true,
      });
    }
  });
}
