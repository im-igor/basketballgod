import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listPlayers } from '../db/repos/players.repo.js';
import type { Player, PlayerTeam } from '../db/types.js';
import { log } from '../util/logger.js';
import { playerStatusLabel } from '../domain/playerStatus.js';

export function memberTag(team: PlayerTeam, active = true): string {
  return playerStatusLabel({ team, active });
}

export interface MemberTagSyncResult {
  tagged: number;
  skippedAdmins: number;
  missingId: number;
  absent: number;
  errors: number;
}

/**
 * Telegram разрешает выставлять member tag только обычным участникам. Админские
 * титулы пользователя не меняем: администраторы здесь намеренно пропускаются.
 */
export async function syncMemberTags(api: Api, players?: Player[]): Promise<MemberTagSyncResult> {
  const result: MemberTagSyncResult = { tagged: 0, skippedAdmins: 0, missingId: 0, absent: 0, errors: 0 };
  for (const player of players ?? await listPlayers()) {
    if (!player.tg_user_id) {
      result.missingId++;
      continue;
    }
    try {
      const member = await api.getChatMember(env.collectionChat.chatId, player.tg_user_id);
      if (member.status === 'administrator' || member.status === 'creator') {
        result.skippedAdmins++;
        continue;
      }
      if (member.status !== 'member') {
        result.absent++;
        continue;
      }
      await api.setChatMemberTag(env.collectionChat.chatId, player.tg_user_id, memberTag(player.team, player.active));
      result.tagged++;
    } catch (err) {
      result.errors++;
      log.warn(`[member-tags] не удалось обновить тег ${player.tg_login}`, (err as Error).message);
    }
  }
  return result;
}
