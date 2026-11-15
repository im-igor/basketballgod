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
  alreadyCorrect: number;
  skippedAdmins: number;
  missingId: number;
  absent: number;
  errors: number;
}

export interface MemberTagSyncOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  minWriteIntervalMs?: number;
  maxRateLimitRetries?: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function retryAfterSeconds(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const error = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  const retryAfter = error.parameters?.retry_after;
  return error.error_code === 429 && typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : null;
}

/**
 * Telegram разрешает выставлять member tag только обычным участникам. Админские
 * титулы пользователя не меняем: администраторы здесь намеренно пропускаются.
 */
export async function syncMemberTags(
  api: Api,
  players?: Player[],
  options: MemberTagSyncOptions = {},
): Promise<MemberTagSyncResult> {
  const result: MemberTagSyncResult = {
    tagged: 0,
    alreadyCorrect: 0,
    skippedAdmins: 0,
    missingId: 0,
    absent: 0,
    errors: 0,
  };
  const sleep = options.sleep ?? defaultSleep;
  const minWriteIntervalMs = options.minWriteIntervalMs ?? 750;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  let wroteTag = false;

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
      const desiredTag = memberTag(player.team, player.active);
      if (member.tag === desiredTag) {
        result.alreadyCorrect++;
        continue;
      }

      if (wroteTag && minWriteIntervalMs > 0) await sleep(minWriteIntervalMs);
      let retries = 0;
      while (true) {
        try {
          await api.setChatMemberTag(env.collectionChat.chatId, player.tg_user_id, desiredTag);
          result.tagged++;
          wroteTag = true;
          break;
        } catch (err) {
          const retryAfter = retryAfterSeconds(err);
          if (retryAfter === null || retries >= maxRateLimitRetries) throw err;
          retries++;
          const waitMs = (retryAfter + 1) * 1000;
          log.warn(`[member-tags] Telegram ограничил частоту, повтор через ${retryAfter + 1} с`);
          await sleep(waitMs);
        }
      }
    } catch (err) {
      result.errors++;
      log.warn(`[member-tags] не удалось обновить тег ${player.tg_login}`, (err as Error).message);
    }
  }
  return result;
}
