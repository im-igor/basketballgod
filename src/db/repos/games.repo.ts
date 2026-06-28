import { query } from '../pool.js';
import type { Game, GameParticipant, Team } from '../types.js';

export async function saveGame(g: {
  event_uid: string | null;
  team: Team;
  opponent: string | null;
  played_on: string | null;
  stat_url: string | null;
  fee_per_player: number;
  participants: GameParticipant[];
  month: number;
  year: number;
}): Promise<Game> {
  const { rows } = await query<Game>(
    `insert into games (event_uid, team, opponent, played_on, stat_url, fee_per_player, participants, month, year)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      g.event_uid,
      g.team,
      g.opponent,
      g.played_on,
      g.stat_url,
      g.fee_per_player,
      JSON.stringify(g.participants),
      g.month,
      g.year,
    ],
  );
  return rows[0]!;
}

/** Удалить ранее сохранённые игры по ссылке (дедуп при повторной регистрации). */
export async function deleteGamesByUrl(statUrl: string): Promise<void> {
  await query('delete from games where stat_url = $1', [statUrl]);
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

export async function listGames(limit = 50): Promise<Game[]> {
  const { rows } = await query<Game>('select * from games order by played_on desc nulls last limit $1', [
    limit,
  ]);
  return rows;
}
