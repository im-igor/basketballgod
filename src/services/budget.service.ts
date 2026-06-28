import { env } from '../config/env.js';
import { listEvents } from '../google/calendar.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listGamesForMonth } from '../db/repos/games.repo.js';
import { saveBudget, type ChargeInput } from '../db/repos/budgets.repo.js';
import { computeBudgets, type BudgetEvent, type GameForBudget, type TeamBudget } from '../domain/budget.js';
import { buildBudgetMessage } from '../domain/messages.js';
import { monthRange } from '../domain/dates.js';
import type { Player, Team } from '../db/types.js';

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
}

/** Собрать и сохранить бюджеты обеих команд за месяц; вернуть тексты сообщений. */
export async function buildAndSaveBudgets(
  month: number,
  year: number,
): Promise<Record<Team, BuiltBudget>> {
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
  const games: Record<Team, GameForBudget[]> = {
    RED: redGames.map((g) => ({ team: g.team, fee_per_player: g.fee_per_player, participants: g.participants })),
    BLACK: blackGames.map((g) => ({ team: g.team, fee_per_player: g.fee_per_player, participants: g.participants })),
  };

  const computed = computeBudgets({ month, year, tariffs, events, active, games });

  const out = {} as Record<Team, BuiltBudget>;
  for (const team of TEAMS) {
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
      payment: { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL },
    });
    out[team] = { team, budgetId: saved.id, result, message };
  }
  return out;
}
