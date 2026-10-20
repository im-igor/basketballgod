import type { Api } from 'grammy';
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
  setBudgetChatCheck,
  type ChargeInput,
} from '../db/repos/budgets.repo.js';
import { computeBudgets, usesSharedCoach, type BudgetEvent, type GameForBudget, type TeamBudget } from '../domain/budget.js';
import { reconcileActivityDates } from '../domain/activity.js';
import { gameFeeForPlayer, gamesForPlayers } from '../domain/gamefee.js';
import { buildBudgetMessage } from '../domain/messages.js';
import { monthRange } from '../domain/dates.js';
import { correctionNote, isLegacyAutoCorrectionNote, proposeCorrection, snapshotEvents } from '../domain/budgetCorrections.js';
import { checkTeamChatMembership } from './chatCheck.service.js';
import type { BudgetCorrection, BudgetDetails, Player, Team } from '../db/types.js';

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
  api?: Api,
): Promise<BuiltBudget[]> {
  const { from, to } = monthRange(month, year);
  const sourceMonth = month === 1 ? 12 : month - 1;
  const sourceYear = month === 1 ? year - 1 : year;
  const { from: sourceFrom, to: sourceTo } = monthRange(sourceMonth, sourceYear);

  const [tariffs, allPlayers, redEvents, blackEvents, sourceRedEvents, sourceBlackEvents,
    sourceRedBudget, sourceBlackBudget] = await Promise.all([
    getTariffs(),
    listPlayers(),
    listEvents('RED', from, to),
    listEvents('BLACK', from, to),
    listEvents('RED', sourceFrom, sourceTo),
    listEvents('BLACK', sourceFrom, sourceTo),
    getBudget('RED', sourceMonth, sourceYear),
    getBudget('BLACK', sourceMonth, sourceYear),
  ]);
  const snapshot = snapshotEvents([...redEvents, ...blackEvents], tariffs);
  const suggested = proposeCorrection(sourceMonth, sourceYear, sourceRedBudget, sourceBlackBudget,
    [...sourceRedEvents, ...sourceBlackEvents], tariffs);

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
  const previous = await Promise.all(TEAMS.map((team) => getBudget(team, month, year)));
  if (previous.some((budget) => budget?.message_id != null)) {
    throw new Error('Опубликованный бюджет нельзя пересобрать. Корректировку внеси в следующий черновик.');
  }
  const previousByTeam = { RED: previous[0], BLACK: previous[1] };
  const priorCorrection = previous.find((budget) => budget?.details?.correction)?.details?.correction;
  const correction = priorCorrection ? structuredClone(priorCorrection) : suggested;
  // Сохраняем список платных событий актуального календаря вместе с проверяемым хешем.
  correction.source_snapshot = suggested.source_snapshot;
  correction.source_removed_dates = suggested.source_removed_dates;
  correction.source_added_dates = suggested.source_added_dates;
  if (priorCorrection?.source_fingerprint && priorCorrection.source_fingerprint !== suggested.source_fingerprint) {
    correction.source_fingerprint = suggested.source_fingerprint;
    correction.source_changes = suggested.source_changes;
    correction.reviewed = false;
    if (!correction.quantities_edited) {
      correction.coach_delta = suggested.coach_delta;
      correction.gym_delta = suggested.gym_delta;
    }
  }
  if (!correction.note_edited || isLegacyAutoCorrectionNote(correction)) {
    correction.note_edited = false;
    correction.note = correctionNote(correction);
  }
  const effectiveCoach = Object.fromEntries(TEAMS.map((team) => [team, Math.max(
    0, computed[team].details.coach_sessions + (previousByTeam[team]?.details?.coach_delta ?? 0),
  )])) as Record<Team, number>;
  const sharedNotes = Object.fromEntries(TEAMS.map((team) => [
    team, previousByTeam[team]?.details?.coach_note ?? null,
  ])) as Record<Team, string | null>;
  const shared = usesSharedCoach(month, year);
  const totalPlayers = computed.RED.details.total_players;
  const carryCoach = (correction.coach_delta.RED + correction.coach_delta.BLACK) * correction.coach_rate;
  const gymTotal = computed.RED.details.paid_gym_sessions * tariffs.gym_paid_price +
    tariffs.locker_rent_price + correction.gym_delta * correction.gym_rate;
  const gymPer = totalPlayers > 0 ? Math.ceil(gymTotal / totalPlayers) : 0;
  const sharedCoachPer = totalPlayers > 0
    ? Math.ceil(((effectiveCoach.RED + effectiveCoach.BLACK) * tariffs.coach_per_session + carryCoach) / totalPlayers)
    : 0;

  const out: BuiltBudget[] = [];
  const savedForCheck: { team: Team; id: number; logins: string[] }[] = [];
  // При общем тренере изменение расписания одной команды влияет на оба бюджета.
  for (const team of shared ? TEAMS : teamsToProcess) {
    const result = computed[team];

    // Переносим ранее внесённые ручные правки тренера (если бюджет уже существует).
    const prev = previousByTeam[team];
    const prevDetails = prev?.details as BudgetDetails | null;
    const coachDelta = prevDetails?.coach_delta ?? 0;
    const coachNote = prevDetails?.coach_note ?? null;
    const coachPer =
      shared ? sharedCoachPer : result.details.players_team > 0
        ? Math.ceil((effectiveCoach[team] * tariffs.coach_per_session +
          correction.coach_delta[team] * correction.coach_rate) / result.details.players_team)
        : 0;
    const base = gymPer + coachPer;
    if (base < 0) throw new Error('Зачёт превышает новый сбор. Уменьши корректировку или перенеси остаток на следующий месяц.');

    const details: BudgetDetails = {
      ...result.details,
      gym_per_person: gymPer,
      coach_per_person: coachPer,
      base_per_person: base,
      ...(shared ? { coach_shared_sessions: effectiveCoach, coach_shared_notes: sharedNotes } : {}),
      coach_delta: coachDelta,
      coach_note: coachNote,
      event_snapshot: snapshot,
      correction,
      ...(prevDetails?.chat_check ? { chat_check: prevDetails.chat_check } : {}),
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
    savedForCheck.push({ team, id: saved.id, logins: savedCharges.map((c) => c.tg_login) });
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
    if (teamsToProcess.includes(team)) out.push({ team, budgetId: saved.id, result, message, gamesCount: teamGames.length });
  }
  if (api) {
    const checkedAt = new Date().toISOString();
    await Promise.all(savedForCheck.map(async ({ team, id, logins }) => {
      const checks = await checkTeamChatMembership(api, team, logins);
      await setBudgetChatCheck(id, {
        checked_at: checkedAt,
        statuses: Object.fromEntries(checks.map((check) => [check.tg_login.toLowerCase(), check.status])),
      });
    }));
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
  opts: { coachDeltaChange?: number; coachNote?: string; correction?: BudgetCorrection } = {},
): Promise<RecalcResult | null> {
  const budget = await getBudgetById(budgetId);
  if (!budget || !budget.details) return null;
  if (budget.message_id != null) throw new Error('Опубликованный бюджет нельзя изменить');
  const d = budget.details as BudgetDetails;

  const [tariffs, charges, allGames] = await Promise.all([
    getTariffs(),
    getCharges(budgetId),
    listAllGamesForMonth(budget.month, budget.year),
  ]);

  const coachDelta = (d.coach_delta ?? 0) + (opts.coachDeltaChange ?? 0);
  const correction = opts.correction ?? d.correction;
  const coachNote =
    opts.coachNote !== undefined ? opts.coachNote || null : d.coach_note ?? null;
  const effCoach = Math.max(0, d.coach_sessions + coachDelta);
  const shared = usesSharedCoach(budget.month, budget.year);
  const otherTeam = budget.team === 'RED' ? 'BLACK' : 'RED';
  const other = shared ? await getBudget(otherTeam, budget.month, budget.year) : null;
  const otherDetails = other?.details as BudgetDetails | null | undefined;
  const otherEffCoach = otherDetails
    ? Math.max(0, otherDetails.coach_sessions + (otherDetails.coach_delta ?? 0))
    : d.coach_shared_sessions?.[otherTeam] ?? 0;
  const sharedSessions: Record<Team, number> = budget.team === 'RED'
    ? { RED: effCoach, BLACK: otherEffCoach }
    : { RED: otherEffCoach, BLACK: effCoach };
  const sharedNotes: Record<Team, string | null> = budget.team === 'RED'
    ? { RED: coachNote, BLACK: otherDetails?.coach_note ?? d.coach_shared_notes?.BLACK ?? null }
    : { RED: otherDetails?.coach_note ?? d.coach_shared_notes?.RED ?? null, BLACK: coachNote };
  const carryCoach = correction
    ? (correction.coach_delta.RED + correction.coach_delta.BLACK) * correction.coach_rate : 0;
  const gymTotal = d.paid_gym_sessions * tariffs.gym_paid_price + tariffs.locker_rent_price +
    (correction ? correction.gym_delta * correction.gym_rate : 0);
  const gymPer = correction
    ? d.total_players > 0 ? Math.ceil(gymTotal / d.total_players) : 0
    : d.gym_per_person;
  const coachPer = shared
    ? d.total_players > 0
      ? Math.ceil(((sharedSessions.RED + sharedSessions.BLACK) * tariffs.coach_per_session + carryCoach) / d.total_players)
      : 0
    : d.players_team > 0 ? Math.ceil((effCoach * tariffs.coach_per_session +
      (correction?.coach_delta[budget.team] ?? 0) * (correction?.coach_rate ?? 0)) / d.players_team) : 0;
  const base = gymPer + coachPer;
  if (base < 0) throw new Error('Зачёт превышает новый сбор. Уменьши корректировку или перенеси остаток на следующий месяц.');

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
    gym_per_person: gymPer,
    coach_per_person: coachPer,
    base_per_person: base,
    ...(correction ? { correction } : {}),
    ...(shared ? { coach_shared_sessions: sharedSessions, coach_shared_notes: sharedNotes } : {}),
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

/** Карточка корректировок общая для обеих команд и пересчитывает оба черновика. */
export async function updateBudgetCorrection(month: number, year: number, correction: BudgetCorrection): Promise<void> {
  if (!correction.note_edited || isLegacyAutoCorrectionNote(correction)) {
    correction.note_edited = false;
    correction.note = correctionNote(correction);
  }
  const budgets = await Promise.all(TEAMS.map((team) => getBudget(team, month, year)));
  if (budgets.some((budget) => budget?.message_id != null)) {
    throw new Error('Опубликованный бюджет нельзя изменить');
  }
  for (const budget of budgets) if (budget) await recalcBudget(budget.id, { correction });
}
