import type { Context, NextFunction } from 'grammy';
import { env } from '../../config/env.js';

const admins = new Set(env.ADMIN_TG_IDS);

export function isAdmin(userId: number | undefined): boolean {
  return userId !== undefined && admins.has(userId);
}

/** Обёртка для админских команд: молча игнорируем не-админов в группах,
 *  но отвечаем в личке. */
export function adminOnly(
  handler: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    if (!isAdmin(ctx.from?.id)) {
      if (ctx.chat?.type === 'private') {
        await ctx.reply('⛔ Команда доступна только администраторам команды.');
      }
      return;
    }
    await handler(ctx);
  };
}
