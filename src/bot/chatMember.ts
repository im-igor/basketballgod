import type { Bot, Context } from 'grammy';
import { env } from '../config/env.js';
import { getByTelegramUserId } from '../db/repos/players.repo.js';
import type { Player } from '../db/types.js';
import { log } from '../util/logger.js';

type ChatMemberState = {
  status: string;
  is_member?: boolean;
};

function isMember(member: ChatMemberState): boolean {
  return member.status === 'creator'
    || member.status === 'administrator'
    || member.status === 'member'
    || (member.status === 'restricted' && member.is_member === true);
}

function teamByChatId(chatId: number): 'RED' | 'BLACK' | null {
  if (chatId === env.chats.RED.chatId) return 'RED';
  if (chatId === env.chats.BLACK.chatId) return 'BLACK';
  return null;
}

/**
 * Сообщаем администраторам только о фактическом выходе игрока из его чата.
 * Для этого бот должен быть администратором чата: иначе Telegram не присылает
 * обновления chat_member для других участников.
 */
export function createChatMemberHandler(
  findPlayer: (tgUserId: number) => Promise<Player | null> = getByTelegramUserId,
  adminIds: readonly number[] = env.ADMIN_TG_IDS,
): (ctx: Context) => Promise<void> {
  return async (ctx: Context): Promise<void> => {
    const update = ctx.chatMember;
    if (!update) return;

    const team = teamByChatId(update.chat.id);
    if (
      !team
      || !isMember(update.old_chat_member as ChatMemberState)
      || isMember(update.new_chat_member as ChatMemberState)
    ) {
      return;
    }

    try {
      const player = await findPlayer(update.new_chat_member.user.id);
      // Один Telegram ID может быть в БД, но только выход из домашнего чата игрока важен.
      if (!player || player.team !== team) return;

      const message = `🏀 Игрок ${player.name} (${player.tg_login}) вышел из чата ${team}.`;
      await Promise.all(adminIds.map(async (adminId) => {
        try {
          await ctx.api.sendMessage(adminId, message);
        } catch (err) {
          log.warn(`[chat_member] не удалось уведомить администратора ${adminId}`, (err as Error).message);
        }
      }));
    } catch (err) {
      log.error('[chat_member] не удалось обработать выход игрока из чата', (err as Error).message);
    }
  };
}

export function registerChatMemberNotifications(bot: Bot): void {
  bot.on('chat_member', createChatMemberHandler());
}
