import { fetchGameStats, selectTeamPlayers } from '../gamefee/parser.js';
import {
  saveGame,
  deleteGamesByUrl,
  getGameById,
  updateGameFee,
} from '../db/repos/games.repo.js';
import { getByLogin } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { computeGameFee } from '../domain/gamefee.js';
import { normalizeLogin } from '../util/args.js';
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
 * Сопоставление имени со страницы с игроком из ростера (обеих команд — кросс-команда).
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
 * находиться в ростере (любой команды — кросс-команда) с `active=YES` и `employee=TRUE`.
 * Иначе — список ошибок. `roster` — активные игроки обеих команд.
 */
export async function validateGame(
  url: string,
  team: Team,
  date: string | null,
  roster: Player[],
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
    const matched = matchPlayer(p.name, roster);
    if (!matched) {
      errors.push(`${url} (${team}): «${p.name}» не найден в ростере (RED/BLACK)`);
    } else if (!matched.active) {
      errors.push(`${url} (${team}): «${matched.name}» неактивен (active=NO)`);
    } else if (!matched.is_employee) {
      errors.push(`${url} (${team}): «${matched.name}» не сотрудник (employee=FALSE)`);
    } else {
      participants.push({ name: p.name, tg_login: matched.tg_login, matched_player_id: matched.id });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Авто-игры (лига): тренер по умолчанию был, судьи нет; при необходимости правится тумблером.
  const fee = computeGameFee(tariffs, { coach_present: true, judge: false }, sel.played.length);
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

/**
 * Зарегистрировать внеплановый товарищеский (MIXED) из списка @login сыгравших.
 * Взнос = ceil((тренер?coach_per_game:0 + судья?referee_default:0) / число сыгравших),
 * делится на участников (каждый — в бюджете своей команды). Возвращает счётчики и несопоставленных.
 */
export async function registerFriendly(
  logins: string[],
  opts: { coach: boolean; judge: boolean; label?: string },
  month: number,
  year: number,
): Promise<{ matched: number; unmatched: string[]; fee: number }> {
  const tariffs = await getTariffs();
  const matched: Player[] = [];
  const unmatched: string[] = [];
  for (const raw of logins) {
    const login = normalizeLogin(raw);
    const p = await getByLogin(login);
    if (p) matched.push(p);
    else unmatched.push(login);
  }
  if (matched.length === 0) return { matched: 0, unmatched, fee: 0 };

  const fee = computeGameFee(tariffs, { coach_present: opts.coach, judge: opts.judge }, matched.length);
  const participants: GameParticipant[] = matched.map((p) => ({
    name: p.name,
    tg_login: p.tg_login,
    matched_player_id: p.id,
  }));
  await saveGame({
    event_uid: null,
    team: 'MIXED',
    opponent: opts.label ?? 'товарищеский',
    played_on: null,
    stat_url: null,
    fee_per_player: fee,
    participants,
    coach_present: opts.coach,
    judge: opts.judge,
    month,
    year,
  });
  return { matched: matched.length, unmatched, fee };
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
      coach_present: true,
      judge: false,
      month,
      year,
    });
  }
}

/**
 * Ручной ввод игры (основной путь для лиги BLACK/МЛБЛ — её стат-сайт не парсится).
 * Состав задаётся списком @login (кросс-командно, `getByLogin` без фильтра команды),
 * взнос — из флагов тренер/судья. `team` — только метка (лига/фикстура), на учёт не влияет:
 * взнос каждому падает в бюджет его домашней команды.
 */
export async function registerManualGame(
  opts: {
    team: Team | 'MIXED';
    opponent: string | null;
    date: string | null;
    logins: string[];
    coach: boolean;
    judge: boolean;
  },
  month: number,
  year: number,
): Promise<{ matched: number; unmatched: string[]; fee: number }> {
  const tariffs = await getTariffs();
  const matched: Player[] = [];
  const unmatched: string[] = [];
  for (const raw of opts.logins) {
    const login = normalizeLogin(raw);
    const p = await getByLogin(login);
    if (p) matched.push(p);
    else unmatched.push(login);
  }
  if (matched.length === 0) return { matched: 0, unmatched, fee: 0 };

  const fee = computeGameFee(tariffs, { coach_present: opts.coach, judge: opts.judge }, matched.length);
  const participants: GameParticipant[] = matched.map((p) => ({
    name: p.name,
    tg_login: p.tg_login,
    matched_player_id: p.id,
  }));
  await saveGame({
    event_uid: null,
    team: opts.team,
    opponent: opts.opponent,
    played_on: opts.date,
    stat_url: null,
    fee_per_player: fee,
    participants,
    coach_present: opts.coach,
    judge: opts.judge,
    month,
    year,
  });
  return { matched: matched.length, unmatched, fee };
}

/**
 * Пересчитать взнос игры из пер-игровых флагов (после тумблера «тренер был» в админке).
 * Возвращает обновлённую игру или null, если игра не найдена.
 */
export async function recomputeGameFee(
  gameId: number,
  flags: { coach_present: boolean; judge: boolean },
): Promise<{ month: number | null; year: number | null } | null> {
  const game = await getGameById(gameId);
  if (!game) return null;
  const tariffs = await getTariffs();
  const played = game.participants?.length ?? 0;
  const fee = computeGameFee(tariffs, flags, played);
  await updateGameFee(gameId, { coach_present: flags.coach_present, judge: flags.judge, fee_per_player: fee });
  return { month: game.month, year: game.year };
}
