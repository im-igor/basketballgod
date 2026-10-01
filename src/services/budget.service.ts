import { env } from '../config/env.js';
import { listEvents } from '../google/calendar.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { listAllGamesForMonth } from '../db/repos/games.repo.js';
import {
  saveBudget,
  getBudget,
  getBudgetById,
  getCharges,
  type ChargeInput,
} from '../db/repos/budgets.repo.js';
import { computeBudgets, type BudgetEvent, type GameForBudget, type TeamBudget } from '../domain/budget.js';
import { reconcileActivityDates } from '../domain/activity.js';
import { gameFeeForPlayer, gamesForPlayers } from '../domain/gamefee.js';
import { buildBudgetMessage } from '../domain/messages.js';
import { monthRange } from '../domain/dates.js';
import type { BudgetDetails, Player, Team } from '../db/types.js';

const TEAMS: Team[] = ['RED', 'BLACK'];

/** Активен ли игрок в указанном месяце (с учётом active_from / active_to). */
function isActiveInMonth(p: Player, month: number, year: number): boolean {
  if (!p.active) return false;
  // Правило «побеждает поздняя дата»: устаревший active_to (раньше active_from) не учитываем.
  const { active_from, active_to } = reconcileActivityDates(p.active_from, p.active_to);
  const firstDay = new Date(year, month - 1, 1);
  if (active_from && new Date(active_from) > firstDay) return false;
  if (active_to && new Date(active_to) < firstDay) return false;
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

  // Единый пул игр месяца: взнос атрибутируется по участнику, а не по команде игры.
  const allGames = await listAllGamesForMonth(month, year);
  const games: GameForBudget[] = allGames.map((g) => ({
    team: g.team,
    fee_per_player: g.fee_per_player,
    participants: g.participants,
  }));

  const computed = computeBudgets({ month, year, tariffs, events, active, games });

  const out: BuiltBudget[] = [];
  for (const team of teamsToProcess) {
    const result = computed[team];

    // Переносим ранее внесённые ручные правки тренера (если бюджет уже существует).
    const prev = await getBudget(team, month, year);
    const prevDetails = prev?.details as BudgetDetails | null;
    const coachDelta = prevDetails?.coach_delta ?? 0;
    const coachNote = prevDetails?.coach_note ?? null;
    const effCoach = Math.max(0, result.details.coach_sessions + coachDelta);
    const coachPer =
      result.details.players_team > 0
        ? Math.ceil((effCoach * tariffs.coach_per_session) / result.details.players_team)
        : 0;
    const base = result.details.gym_per_person + coachPer;

    const details: BudgetDetails = {
      ...result.details,
      coach_per_person: coachPer,
      base_per_person: base,
      coach_delta: coachDelta,
      coach_note: coachNote,
    };
    // Приводим result к учтённой дельте (для инфо-сообщения и возврата).
    result.details = details;
    result.base_per_person = base;

    const charges: ChargeInput[] = result.charges.map((c) => ({
      player_id: c.player.id,
      tg_login: c.player.tg_login,
      name: c.player.name,
      base_amount: base,
      game_amount: c.game_amount,
      amount: base + c.game_amount,
    }));
    const saved = await saveBudget({ team, month, year, total_per_player: base, details, charges });
    const savedCharges = await getCharges(saved.id);
    const teamGames = gamesForPlayers(allGames, savedCharges.map((c) => c.player_id));
    for (const c of result.charges) {
      const stored = savedCharges.find((s) => s.player_id === c.player.id)!;
      c.base_amount = stored.base_amount;
      c.extra_amount = stored.extra_amount;
      c.extra_items = stored.extra_items;
      c.amount = stored.amount;
    }
    const message = buildBudgetMessage({
      team,
      month,
      year,
      details,
      tariffs,
      charges: savedCharges,
      games: teamGames,
      payment: { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL },
    });
    out.push({ team, budgetId: saved.id, result, message, gamesCount: teamGames.length });
  }
  return out;
}

export interface RecalcResult {
  team: Team;
  budgetId: number;
  message: string;
  coachDelta: number;
  effCoach: number;
}

/**
 * Быстрый перерасчёт бюджета по сохранённым details и играм из БД (без Google-календаря).
 * Применяет ручные правки тренера (coach_delta/coach_note) и пер-игроковые взносы, сохраняя
 * статус оплат (paid). Возвращает данные для перерисовки сообщения-черновика.
 */
export async function recalcBudget(
  budgetId: number,
  opts: { coachDeltaChange?: number; coachNote?: string } = {},
): Promise<RecalcResult | null> {
  const budget = await getBudgetById(budgetId);
  if (!budget || !budget.details) return null;
  const d = budget.details as BudgetDetails;

  const [tariffs, charges, allGames] = await Promise.all([
    getTariffs(),
    getCharges(budgetId),
    listAllGamesForMonth(budget.month, budget.year),
  ]);

  const coachDelta = (d.coach_delta ?? 0) + (opts.coachDeltaChange ?? 0);
  const coachNote =
    opts.coachNote !== undefined ? opts.coachNote || null : d.coach_note ?? null;
  const effCoach = Math.max(0, d.coach_sessions + coachDelta);
  const coachPer = d.players_team > 0 ? Math.ceil((effCoach * tariffs.coach_per_session) / d.players_team) : 0;
  const base = d.gym_per_person + coachPer;

  // Взносы за игры — по всему пулу месяца (кросс-команда учитывается по участнику).
  const gamesForBudget: GameForBudget[] = allGames.map((g) => ({
    team: g.team,
    fee_per_player: g.fee_per_player,
    participants: g.participants,
  }));

  // Для сообщения показываем только игры, где сыграл кто-то из игроков этого бюджета.
  const teamGames = gamesForPlayers(allGames, charges.map((c) => c.player_id));

  const updatedCharges = charges.map((c) => {
    const game = c.player_id ? gameFeeForPlayer(c.player_id, gamesForBudget) : c.game_amount;
    return { ...c, base_amount: base, game_amount: game, amount: base + game };
  });

  const newDetails: BudgetDetails = {
    ...d,
    coach_delta: coachDelta,
    coach_note: coachNote,
    coach_per_person: coachPer,
    base_per_person: base,
  };
  await saveBudget({
    team: budget.team, month: budget.month, year: budget.year,
    total_per_player: base, details: newDetails, charges: updatedCharges,
  });

  const message = buildBudgetMessage({
    team: budget.team,
    month: budget.month,
    year: budget.year,
    details: newDetails,
    tariffs,
    charges: await getCharges(budgetId),
    games: teamGames,
    payment: { sberUrl: env.PAYMENT_SBER_URL, tbankUrl: env.PAYMENT_TBANK_URL },
  });

  return { team: budget.team, budgetId, message, coachDelta, effCoach };
}
