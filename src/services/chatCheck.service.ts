import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { log } from '../util/logger.js';
import type { Team } from '../db/types.js';

export type ChatStatus = 'member' | 'left' | 'missing_id' | 'check_error';

export interface MemberCheck {
  tg_login: string;
  status: ChatStatus;
}

/**
 * Проверка присутствия начисляемых игроков в чате их домашней команды перед сбором.
 *
 * Ограничение Telegram Bot API: членство можно проверить только по числовому user_id
 * (getChatMember) — по @username нельзя (нет ни резолва username→id, ни листинга участников).
 * `players.tg_user_id` проставляется при голосовании или команде /start в личке.
 * Без ID получаем missing_id; вышедший/удалённый участник — left; ошибка Telegram —
 * check_error. Для надёжной проверки других участников бот должен быть администратором чата.
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
    const userId = Number(p?.tg_user_id);
    if (!p || p.tg_user_id == null || !Number.isSafeInteger(userId) || userId <= 0) {
      out.push({ tg_login: login, status: 'missing_id' });
      continue;
    }
    try {
      const m = await api.getChatMember(chatId, userId);
      const inChat =
        m.status === 'creator' ||
        m.status === 'administrator' ||
        m.status === 'member' ||
        (m.status === 'restricted' && m.is_member);
      out.push({ tg_login: login, status: inChat ? 'member' : 'left' });
    } catch (err) {
      log.warn(
        `[chatcheck] getChatMember(${chatId}, ${userId}) не удалось`,
        (err as Error).message,
      );
      out.push({ tg_login: login, status: 'check_error' });
    }
  }
  return out;
}

/** Статус членства каждого начисляемого игрока по логину в нижнем регистре. */
export async function chatStatusesByLogin(api: Api, team: Team, logins: string[]): Promise<Map<string, ChatStatus>> {
  const checks = await checkTeamChatMembership(api, team, logins);
  return new Map(checks.map((c) => [c.tg_login.toLowerCase(), c.status]));
}
