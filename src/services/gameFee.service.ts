import { env } from '../config/env.js';
import { fetchGameStats, pickOurPlayers, type ParsedPlayer } from '../gamefee/parser.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { saveGame } from '../db/repos/games.repo.js';
import { feePerPlayer } from '../domain/gamefee.js';
import type { GameParticipant, Player, Team } from '../db/types.js';

function surname(fullName: string): string {
  return (fullName.trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** Грубое сопоставление имени со страницы с игроком из ростера по фамилии. */
function matchPlayer(name: string, roster: Player[]): Player | undefined {
  const sn = surname(name);
  if (!sn) return undefined;
  const candidates = roster.filter((p) => surname(p.name) === sn);
  return candidates[0];
}

export interface GameFeeResult {
  url: string;
  teamName: string;
  played: ParsedPlayer[];
  fee_per_player: number;
  participants: GameParticipant[];
  unmatched: string[];
  team: Team | 'MIXED';
}

/**
 * Посчитать взнос за одну игру по URL статистики и сохранить запись игры.
 * totalFee по умолчанию = тариф «тренер за игру».
 */
export async function processGameUrl(
  url: string,
  opts: { playedOn?: string; totalFee?: number } = {},
): Promise<GameFeeResult> {
  const [tariffs, roster] = await Promise.all([getTariffs(), listPlayers()]);
  const totalFee = opts.totalFee ?? tariffs.coach_per_game;

  const game = await fetchGameStats(url);
  const our = pickOurPlayers(game, env.OUR_TEAM_KEYWORD);
  if (!our || our.played.length === 0) {
    throw new Error('Не удалось определить сыгравших игроков на странице.');
  }

  const fee = feePerPlayer(totalFee, our.played.length);

  const participants: GameParticipant[] = [];
  const unmatched: string[] = [];
  const teamsHit = new Set<Team>();

  for (const p of our.played) {
    const matched = matchPlayer(p.name, roster);
    if (matched) {
      participants.push({
        name: p.name,
        tg_login: matched.tg_login,
        matched_player_id: matched.id,
      });
      teamsHit.add(matched.team);
    } else {
      participants.push({ name: p.name });
      unmatched.push(p.name);
    }
  }

  const team: Team | 'MIXED' = teamsHit.size === 1 ? [...teamsHit][0]! : 'MIXED';

  const playedOn = opts.playedOn ?? null;
  const now = playedOn ? new Date(playedOn) : new Date();

  await saveGame({
    event_uid: null,
    team,
    played_on: playedOn,
    stat_url: url,
    fee_per_player: fee,
    participants,
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  });

  return { url, teamName: our.teamName, played: our.played, fee_per_player: fee, participants, unmatched, team };
}

/** Обработать несколько URL за один вызов команды. */
export async function processGameUrls(urls: string[]): Promise<GameFeeResult[]> {
  const results: GameFeeResult[] = [];
  for (const url of urls) {
    results.push(await processGameUrl(url));
  }
  return results;
}
