import { query } from '../pool.js';
import type { Game, GameParticipant, Team } from '../types.js';

export async function saveGame(g: {
  event_uid: string | null;
  team: Team | 'MIXED';
  opponent: string | null;
  played_on: string | null;
  stat_url: string | null;
  fee_per_player: number;
  participants: GameParticipant[];
  coach_present?: boolean;
  judge?: boolean;
  month: number;
  year: number;
}): Promise<Game> {
  const { rows } = await query<Game>(
    `insert into games (event_uid, team, opponent, played_on, stat_url, fee_per_player, participants, coach_present, judge, month, year)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      g.event_uid,
      g.team,
      g.opponent,
      g.played_on,
      g.stat_url,
      g.fee_per_player,
      JSON.stringify(g.participants),
      g.coach_present ?? true,
      g.judge ?? false,
      g.month,
      g.year,
    ],
  );
  return rows[0]!;
}

/**
 * Удалить ранее сохранённые игры по ссылке (дедуп при повторной регистрации).
 * Query/hash и завершающий `/` не являются частью идентичности матча: ссылка МЛБЛ
 * может быть скопирована с `#protocol`, `lang` и по-разному закодированным `apiUrl`.
 */
export async function deleteGamesByUrl(statUrl: string): Promise<void> {
  let identity = statUrl;
  try {
    const url = new URL(statUrl);
    identity = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    // Ссылки до сохранения валидируются парсером; оставляем точное сравнение как фолбэк.
  }
  await query(
    `delete from games
     where stat_url = $1
        or regexp_replace(regexp_replace(stat_url, '[?#].*$', ''), '/+$', '') = $2`,
    [statUrl, identity],
  );
}

/** Удалить последний добавленный вручную товарищеский (MIXED, без stat_url) за месяц. */
export async function deleteLastManualFriendly(month: number, year: number): Promise<Game | null> {
  const { rows } = await query<Game>(
    `delete from games
     where id = (
       select id from games
       where month = $1 and year = $2 and team = 'MIXED' and stat_url is null
       order by id desc limit 1
     )
     returning *`,
    [month, year],
  );
  return rows[0] ?? null;
}

/** Игры команды за месяц (для включения взносов в бюджет). */
export async function listGamesForMonth(
  team: Team,
  month: number,
  year: number,
): Promise<Game[]> {
  const { rows } = await query<Game>(
    `select * from games
     where month = $2 and year = $3 and (team = $1 or team = 'MIXED')
     order by played_on nulls last, id`,
    [team, month, year],
  );
  return rows;
}

/**
 * Все игры месяца без фильтра по команде. Взносы теперь атрибутируются по участнику
 * (matched_player_id), а не по команде игры — поэтому бюджет считается по единому пулу.
 */
export async function listAllGamesForMonth(month: number, year: number): Promise<Game[]> {
  const { rows } = await query<Game>(
    `select * from games
     where month = $1 and year = $2
     order by played_on nulls last, id`,
    [month, year],
  );
  return rows;
}

export async function listGames(limit = 50): Promise<Game[]> {
  const { rows } = await query<Game>('select * from games order by played_on desc nulls last limit $1', [
    limit,
  ]);
  return rows;
}

export async function getGameById(id: number): Promise<Game | null> {
  const { rows } = await query<Game>('select * from games where id = $1', [id]);
  return rows[0] ?? null;
}

/** Обновить флаги присутствия и пересчитанный взнос (после тумблера в админке). */
export async function updateGameFee(
  id: number,
  patch: { coach_present: boolean; judge: boolean; fee_per_player: number },
): Promise<void> {
  await query(
    'update games set coach_present = $2, judge = $3, fee_per_player = $4 where id = $1',
    [id, patch.coach_present, patch.judge, patch.fee_per_player],
  );
}

export async function deleteGameById(id: number): Promise<Game | null> {
  const { rows } = await query<Game>('delete from games where id = $1 returning *', [id]);
  return rows[0] ?? null;
}
