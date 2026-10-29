import { budgetTransaction } from '../db/pool.js';
import {
  canonicalGameStatsUrl,
  fetchGameStats,
  gameStatsRef,
  selectTeamPlayers,
} from '../gamefee/parser.js';
import {
  saveGame,
  getGameById,
  updateGameFee,
} from '../db/repos/games.repo.js';
import { getByLogin } from '../db/repos/players.repo.js';
import {
  findScheduledGameForManualEntry,
  getScheduledGameByExternalId,
  getScheduledGameById,
} from '../db/repos/scheduledGames.repo.js';
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
export function matchPlayer(name: string, teamRoster: Player[], strictOnly = false): Player | undefined {
  const tokens = nameTokens(name);
  if (tokens.length < (strictOnly ? 2 : 1)) return undefined;

  const rosterTokens = teamRoster.map((p) => ({ p, t: new Set(nameTokens(p.name)) }));

  // Строгий матч: все токены страницы присутствуют в записи ростера.
  const strict = rosterTokens.filter(({ t }) => tokens.every((tok) => t.has(tok)));
  if (strict.length === 1) return strict[0]!.p;
  if (strict.length > 1) return undefined; // неоднозначно — не угадываем

  if (strictOnly) return undefined;

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
  coachPresent: boolean;
  calendarEventId: string | null;
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
  automatic = false,
): Promise<GameValidation> {
  const ref = gameStatsRef(url);
  const scheduled = await getScheduledGameByExternalId(ref.source, ref.externalId);
  const game = await fetchGameStats(url);
  if (automatic) {
    const color = team.toLowerCase();
    const ours = game.teams.filter((t) => /(?:yandex|яндекс)/i.test(t.name) &&
      new RegExp(`\\b${color}\\b`, 'i').test(t.name));
    if (game.teams.length !== 2 || ours.length !== 1) {
      return { ok: false, errors: ['Неоднозначная команда в протоколе'] };
    }
    // Для взноса важен выход на площадку, а не сумма времени команды.
    const players = ours[0]!.players;
    if (new Set(players.map((p) => nameTokens(p.name).sort().join(' '))).size !== players.length) {
      return { ok: false, errors: ['Повторные строки игроков в протоколе'] };
    }
    if (players.some((p) => !p.name || !Number.isFinite(p.minutes) || p.minutes < 0)) {
      return { ok: false, errors: ['Некорректное время игрока в протоколе'] };
    }
    if (scheduled && game.date && game.date !== String(scheduled.game_date instanceof Date
      ? scheduled.game_date.toISOString() : scheduled.game_date).slice(0, 10)) {
      return { ok: false, errors: ['Дата протокола отличается от расписания'] };
    }
  }
  const sel = selectTeamPlayers(game, team);
  if (!sel || sel.played.length === 0) {
    return { ok: false, errors: [`${url} (${team}): не удалось определить сыгравших на странице`] };
  }

  const errors: string[] = [];
  const participants: GameParticipant[] = [];
  for (const p of sel.played) {
    const matched = matchPlayer(p.name, roster, automatic);
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
  if (new Set(participants.map((p) => p.matched_player_id)).size !== participants.length) {
    errors.push('Несколько строк протокола сопоставлены одному игроку');
  }
  if (errors.length > 0) return { ok: false, errors };

  if (scheduled?.coach_conflict && scheduled.coach_present === null) {
    return {
      ok: false,
      errors: [
        `${url} (${team}): матч пересекается с другой игрой. ` +
        'Сначала выбери в разделе «Расписание», на какой игре будет тренер.',
      ],
    };
  }

  const coachPresent = scheduled?.coach_present ?? true;

  // МЛБЛ отдаёт дату в JSON протокола. Для ЛЧБ используем переданную дату либо
  // дату ранее импортированного расписания.
  const scheduledDate = scheduled?.game_date instanceof Date
    ? scheduled.game_date.toISOString().slice(0, 10)
    : scheduled?.game_date ? String(scheduled.game_date).slice(0, 10) : null;
  const playedOn = game.date ?? date ?? scheduledDate;

  // План тренера берём из импортированного расписания. Без расписания сохраняем прежний дефолт «был».
  const fee = computeGameFee(tariffs, { coach_present: coachPresent, judge: false }, sel.played.length);
  return {
    ok: true,
    plan: {
      url: canonicalGameStatsUrl(ref),
      team,
      teamName: sel.teamName,
      opponent: sel.opponent,
      date: playedOn,
      fee,
      participants,
      playedCount: sel.played.length,
      coachPresent,
      calendarEventId: scheduled?.calendar_event_id ?? null,
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
  await budgetTransaction(async (client) => {
    const existing = (await client.query<{ id: number; stat_url: string | null; month: number; year: number }>(
      'select id, stat_url, month, year from games')).rows;
    const identities = new Set<string>();
    for (const plan of plans) {
      const ref = gameStatsRef(plan.url);
      const key = `${ref.source}:${ref.externalId}`;
      if (identities.has(key)) throw new Error('Один протокол указан несколько раз');
      identities.add(key);
      const matches = existing.filter((g) => {
        if (!g.stat_url) return false;
        try { const other = gameStatsRef(g.stat_url); return other.source === ref.source && other.externalId === ref.externalId; }
        catch { return false; }
      });
      if (matches.some((g) => g.month !== month || g.year !== year)) {
        throw new Error('Матч уже отнесён к другому месяцу бюджета. Проверь прежнее начисление');
      }
      const published = await client.query('select id from budgets where month=$1 and year=$2 and message_id is not null', [month, year]);
      if (published.rows.length) throw new Error('Опубликованный бюджет нельзя менять');
      for (const game of matches) await client.query('delete from games where id=$1', [game.id]);
      await client.query(
        `insert into games (event_uid,team,opponent,played_on,stat_url,fee_per_player,participants,coach_present,judge,month,year)
         values ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10)`,
        [plan.calendarEventId,plan.team,plan.opponent,plan.date,plan.url,plan.fee,
          JSON.stringify(plan.participants),plan.coachPresent,month,year],
      );
    }
  });
}

/**
 * Ручной ввод игры для товарищеских матчей и исключений.
 * Состав задаётся списком @login (кросс-командно, `getByLogin` без фильтра команды),
 * взнос — из флагов тренер/судья. `team` — только метка (лига/фикстура), на учёт не влияет:
 * взнос каждому падает в бюджет его домашней команды.
 */
export async function registerManualGame(
  opts: {
    team: Team | 'MIXED';
    scheduledGameId?: string;
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
  const scheduled = opts.scheduledGameId ? await getScheduledGameById(opts.scheduledGameId)
    : opts.team !== 'MIXED' && opts.date && opts.opponent
    ? await findScheduledGameForManualEntry(opts.team, opts.date, opts.opponent)
    : null;
  if (opts.scheduledGameId && !scheduled) throw new Error('Выбранная игра расписания не найдена');
  const scheduledDate = scheduled ? (scheduled.game_date instanceof Date
    ? scheduled.game_date.toISOString() : String(scheduled.game_date)).slice(0,10) : null;
  if (scheduled && (scheduled.team !== opts.team || (opts.date && opts.date !== scheduledDate))) {
    throw new Error('Команда или дата не совпадает с выбранной игрой расписания');
  }
  if (new Set(opts.logins.map(normalizeLogin)).size !== opts.logins.length) throw new Error('Игрок указан несколько раз');
  if (scheduled?.coach_conflict && scheduled.coach_present === null) {
    throw new Error('У этой игры не решён конфликт тренера. Сначала выбери игру в разделе «Расписание».');
  }
  const coachPresent = scheduled?.coach_present ?? opts.coach;
  const matched: Player[] = [];
  const unmatched: string[] = [];
  for (const raw of opts.logins) {
    const login = normalizeLogin(raw);
    const p = await getByLogin(login);
    if (p) matched.push(p);
    else unmatched.push(login);
  }
  if (unmatched.length) throw new Error(`Не найдены игроки: ${unmatched.join(', ')}. Игра не сохранена`);
  if (matched.length === 0) return { matched: 0, unmatched, fee: 0 };

  const fee = computeGameFee(tariffs, { coach_present: coachPresent, judge: opts.judge }, matched.length);
  const participants: GameParticipant[] = matched.map((p) => ({
    name: p.name,
    tg_login: p.tg_login,
    matched_player_id: p.id,
  }));
  await budgetTransaction(async (client) => {
    const published = await client.query('select id from budgets where month=$1 and year=$2 and message_id is not null', [month,year]);
    if (published.rows.length) throw new Error('Опубликованный бюджет нельзя менять');
    if (scheduled?.calendar_event_id) {
      const existing = await client.query('select id from games where event_uid=$1', [scheduled.calendar_event_id]);
      if (existing.rows.length) throw new Error('Для этой календарной игры уже есть начисление');
    }
    await client.query(
      `insert into games (event_uid,team,opponent,played_on,stat_url,fee_per_player,participants,coach_present,judge,month,year)
       values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9,$10)`,
      [scheduled?.calendar_event_id ?? null, opts.team, opts.opponent ?? (scheduled ?
        `${scheduled.team_a} — ${scheduled.team_b}` : null), scheduledDate ?? opts.date, fee,
        JSON.stringify(participants), coachPresent, opts.judge, month, year],
    );
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
