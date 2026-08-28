import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';

export type ChatStatus = 'member' | 'left' | 'unknown';

export interface MemberCheck {
  tg_login: string;
  status: ChatStatus;
}

/**
 * Проверка присутствия начисляемых игроков в чате их домашней команды перед сбором.
 *
 * Ограничение Telegram Bot API: членство можно проверить только по числовому user_id
 * (getChatMember) — по @username нельзя (нет ни резолва username→id, ни листинга участников).
 * `players.tg_user_id` проставляется при первом голосовании в опросе (см. pollAnswers.ts);
 * у кого его ещё нет → status='unknown' (проверить нечем). Кого нет в чате (вышел/удалён) →
 * status='left'. Бот должен состоять в чате команды, иначе запрос падает → 'unknown'.
 */
export async function checkTeamChatMembership(
  api: Api,
  team: Team,
  logins: string[],
): Promise<MemberCheck[]> {
  const chatId = env.chats[team].chatId;
  const players = await listPlayers();
  const byLogin = new Map(players.map((p) => [p.tg_login.toLowerCase(), p]));

  const out: MemberCheck[] = [];
  for (const login of logins) {
    const p = byLogin.get(login.toLowerCase());
    if (!p || p.tg_user_id == null) {
      out.push({ tg_login: login, status: 'unknown' });
      continue;
    }
    try {
      const m = await api.getChatMember(chatId, p.tg_user_id);
      const inChat =
        m.status === 'creator' ||
        m.status === 'administrator' ||
        m.status === 'member' ||
        (m.status === 'restricted' && m.is_member);
      out.push({ tg_login: login, status: inChat ? 'member' : 'left' });
    } catch (err) {
      log.warn(
        `[chatcheck] getChatMember(${chatId}, ${p.tg_user_id}) не удалось`,
        (err as Error).message,
      );
      out.push({ tg_login: login, status: 'unknown' });
    }
  }
  return out;
}

/**
 * Набор tg_login (в нижнем регистре) начисляемых игроков команды, которых надо пометить
 * в черновике «проверить в чате»: их нет в чате (вышли) ИЛИ проверить нечем (нет user_id).
 */
export async function loginsToFlag(api: Api, team: Team, logins: string[]): Promise<Set<string>> {
  const checks = await checkTeamChatMembership(api, team, logins);
  return new Set(checks.filter((c) => c.status !== 'member').map((c) => c.tg_login.toLowerCase()));
}
