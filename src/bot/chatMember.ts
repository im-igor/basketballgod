import type { Bot, Context } from 'grammy';
import { env } from '../config/env.js';
import { getByTelegramUserId } from '../db/repos/players.repo.js';
import { getCronConfig } from '../db/repos/cronConfig.repo.js';
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

function teamByChatId(chatId: number): 'RED' | 'BLACK' | 'COMMON' | null {
  if (env.COMMON_CHAT_ENABLED && chatId === env.collectionChat.chatId) return 'COMMON';
  if (chatId === env.chats.RED.chatId) return 'RED';
  if (chatId === env.chats.BLACK.chatId) return 'BLACK';
  return null;
}

async function chatMemberCheckEnabled(): Promise<boolean> {
  try {
    return (await getCronConfig()).chat_member_check_enabled;
  } catch (err) {
    // Временная недоступность БД не должна молча выключить уже работавшие уведомления.
    log.warn('[chat_member] не удалось прочитать настройку проверки чата', (err as Error).message);
    return true;
  }
}

/**
 * Сообщаем администраторам только о фактическом выходе игрока из его чата.
 * Для этого бот должен быть администратором чата: иначе Telegram не присылает
 * обновления chat_member для других участников.
 */
export function createChatMemberHandler(
  findPlayer: (tgUserId: number) => Promise<Player | null> = getByTelegramUserId,
  adminIds: readonly number[] = env.ADMIN_TG_IDS,
  isEnabled: () => Promise<boolean> = chatMemberCheckEnabled,
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
      if (!await isEnabled()) return;
      const player = await findPlayer(update.new_chat_member.user.id);
      // В общем чате следим за любым игроком; в исторических чатах — только за
      // игроком своей команды.
      if (!player || (team !== 'COMMON' && player.team !== team && player.team !== 'BOTH')) return;

      const message = `🏀 Игрок ${player.name} (${player.tg_login}) вышел из ${team === 'COMMON' ? 'общего чата' : `чата ${team}`}.`;
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
