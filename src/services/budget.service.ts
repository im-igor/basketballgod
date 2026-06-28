import { env } from '../config/env.js';
import { listEvents } from '../google/calendar.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listGamesForMonth } from '../db/repos/games.repo.js';
import { saveBudget, type ChargeInput } from '../db/repos/budgets.repo.js';
import { computeBudgets, type BudgetEvent, type GameForBudget, type TeamBudget } from '../domain/budget.js';
import { buildBudgetMessage } from '../domain/messages.js';
import { monthRange } from '../domain/dates.js';
import type { Game, Player, Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

/** Активен ли игрок в указанном месяце (с учётом active_from / active_to). */
function isActiveInMonth(p: Player, month: number, year: number): boolean {
  if (!p.active) return false;
  const firstDay = new Date(year, month - 1, 1);
  if (p.active_from && new Date(p.active_from) > firstDay) return false;
  if (p.active_to && new Date(p.active_to) < firstDay) return false;
  return true;
}

export interface BuiltBudget {
  team: Team;
  budgetId: number;
  result: TeamBudget;
  message: string;
  gamesCount: number;
}

/**
 * Собрать и сохранить бюджеты за месяц; вернуть собранные черновики.
 * Считаются обе команды (зал делится на всех активных обеих команд), но сохраняются и
 * возвращаются только указанные в `teamsToProcess` (по умолчанию обе).
 */
export async function buildAndSaveBudgets(
  month: number,
  year: number,
  teamsToProcess: Team[] = TEAMS,
): Promise<BuiltBudget[]> {
  const { from, to } = monthRange(month, year);

  const [tariffs, allPlayers, redEvents, blackEvents] = await Promise.all([
    getTariffs(),
    listPlayers(),
    listEvents('RED', from, to),
    listEvents('BLACK', from, to),
  ]);

  const events: BudgetEvent[] = [...redEvents, ...blackEvents].map((e) => ({
    team: e.team,
    uid: e.uid,
    tags: { TYPE: e.tags.TYPE, GYM: e.tags.GYM, COACH: e.tags.COACH },
  }));

  const active: Record<Team, Player[]> = {
    RED: allPlayers.filter((p) => p.team === 'RED' && isActiveInMonth(p, month, year)),
    BLACK: allPlayers.filter((p) => p.team === 'BLACK' && isActiveInMonth(p, month, year)),
  };

  const [redGames, blackGames] = await Promise.all([
    listGamesForMonth('RED', month, year),
    listGamesForMonth('BLACK', month, year),
  ]);
  const gamesRaw: Record<Team, Game[]> = { RED: redGames, BLACK: blackGames };
  const games: Record<Team, GameForBudget[]> = {
    RED: redGames.map((g) => ({ team: g.team, fee_per_player: g.fee_per_player, participants: g.participants })),
    BLACK: blackGames.map((g) => ({ team: g.team, fee_per_player: g.fee_per_player, participants: g.participants })),
  };

  const computed = computeBudgets({ month, year, tariffs, events, active, games });

  const out: BuiltBudget[] = [];
  for (const team of teamsToProcess) {
    const result = computed[team];
    const charges: ChargeInput[] = result.charges.map((c) => ({
      player_id: c.player.id,
      tg_login: c.player.tg_login,
      name: c.player.name,
      base_amount: c.base_amount,
      game_amount: c.game_amount,
      amount: c.amount,
    }));
    const saved = await saveBudget({
      team,
      month,
      year,
      total_per_player: result.base_per_person,
      details: result.details,
      charges,
    });
    const message = buildBudgetMessage({
      team,
      month,
      year,
      details: result.details,
      tariffs,
      charges: result.charges.map((c) => ({
        name: c.player.name,
        tg_login: c.player.tg_login,
        game_amount: c.game_amount,
        amount: c.amount,
        paid: false,
      })),
      games: gamesRaw[team].map((g) => ({
        played_on: g.played_on,
        opponent: g.opponent,
        fee_per_player: g.fee_per_player,
      })),
      payment: { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL },
    });
    out.push({ team, budgetId: saved.id, result, message, gamesCount: gamesRaw[team].length });
  }
  return out;
}
