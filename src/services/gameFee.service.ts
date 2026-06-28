import { fetchGameStats, selectTeamPlayers } from '../gamefee/parser.js';
import { saveGame, deleteGamesByUrl } from '../db/repos/games.repo.js';
import { feePerPlayer } from '../domain/gamefee.js';
import type { GameParticipant, Player, Tariffs, Team } from '../db/types.js';

/** Токены имени (без знаков), нижним регистром: «Александр Селедцов» → [александр, селедцов]. */
function nameTokens(fullName: string): string[] {
  return fullName
    .toLowerCase()
    .replace(/[^a-zа-яё\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Сопоставление имени со страницы с игроком из (уже отфильтрованного по команде) ростера.
 * Матчим по **ФИО**: засчитываем игрока, только если ВСЕ токены имени со страницы (и имя,
 * и фамилия) есть в записи ростера. Это исключает ложные совпадения по общему имени
 * (несколько «Александров») и различает однофамильцев-братьев (Решин Кирилл / Решин Максим).
 * Фолбэк по фамилии — лишь когда в ростере ровно один человек с такой фамилией (брата нет).
 */
function matchPlayer(name: string, teamRoster: Player[]): Player | undefined {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return undefined;

  const rosterTokens = teamRoster.map((p) => ({ p, t: new Set(nameTokens(p.name)) }));

  // Строгий матч: все токены страницы присутствуют в записи ростера.
  const strict = rosterTokens.filter(({ t }) => tokens.every((tok) => t.has(tok)));
  if (strict.length === 1) return strict[0]!.p;
  if (strict.length > 1) return undefined; // неоднозначно — не угадываем

  // Фолбэк: уникальная фамилия (последний токен на странице «Имя Фамилия»).
  const surname = tokens[tokens.length - 1]!;
  if (surname.length >= 3) {
    const bySurname = rosterTokens.filter(({ t }) => t.has(surname));
    if (bySurname.length === 1) return bySurname[0]!.p;
  }
  return undefined;
}

export interface GamePlan {
  url: string;
  team: Team;
  teamName: string;
  opponent: string | null;
  date: string | null; // ISO YYYY-MM-DD | null
  fee: number;
  participants: GameParticipant[];
  playedCount: number;
}

export type GameValidation = { ok: true; plan: GamePlan } | { ok: false; errors: string[] };

/**
 * Спарсить и проверить игру БЕЗ записи в БД. Каждый вышедший на паркет (время > 0) должен
 * быть игроком указанной команды с `active=YES` и `employee=TRUE`. Иначе — список ошибок.
 */
export async function validateGame(
  url: string,
  team: Team,
  date: string | null,
  teamRoster: Player[],
  tariffs: Tariffs,
): Promise<GameValidation> {
  const game = await fetchGameStats(url);
  const sel = selectTeamPlayers(game, team);
  if (!sel || sel.played.length === 0) {
    return { ok: false, errors: [`${url} (${team}): не удалось определить сыгравших на странице`] };
  }

  const errors: string[] = [];
  const participants: GameParticipant[] = [];
  for (const p of sel.played) {
    const matched = matchPlayer(p.name, teamRoster);
    if (!matched) {
      errors.push(`${url} (${team}): «${p.name}» не найден в ростере ${team}`);
    } else if (!matched.active) {
      errors.push(`${url} (${team}): «${matched.name}» неактивен (active=NO)`);
    } else if (!matched.is_employee) {
      errors.push(`${url} (${team}): «${matched.name}» не сотрудник (employee=FALSE)`);
    } else {
      participants.push({ name: p.name, tg_login: matched.tg_login, matched_player_id: matched.id });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const fee = feePerPlayer(tariffs.coach_per_game, sel.played.length);
  return {
    ok: true,
    plan: {
      url,
      team,
      teamName: sel.teamName,
      opponent: sel.opponent,
      date,
      fee,
      participants,
      playedCount: sel.played.length,
    },
  };
}

/** Сохранить проверенные игры (дедуп по ссылке) с привязкой к месяцу бюджета. */
export async function registerValidatedGames(
  plans: GamePlan[],
  month: number,
  year: number,
): Promise<void> {
  for (const plan of plans) {
    await deleteGamesByUrl(plan.url);
    await saveGame({
      event_uid: null,
      team: plan.team,
      opponent: plan.opponent,
      played_on: plan.date,
      stat_url: plan.url,
      fee_per_player: plan.fee,
      participants: plan.participants,
      month,
      year,
    });
  }
}
