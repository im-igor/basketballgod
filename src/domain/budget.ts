import type { Player, Tariffs, Team, GameParticipant, ExtraFeeItem } from '../db/types.js';
import { gameFeeForPlayer } from './gamefee.js';

/** Минимально нужная инфа о событии (чтобы не тащить тип google в домен). */
export interface BudgetEvent {
  team: Team;
  uid: string;
  tags: { TYPE?: string; GYM?: string; COACH?: string };
}

export interface GameForBudget {
  team: Team | 'MIXED';
  fee_per_player: number | null;
  participants: GameParticipant[];
}

export interface PlayerCharge {
  player: Player;
  base_amount: number;
  game_amount: number;
  extra_amount: number;
  extra_items: ExtraFeeItem[];
  amount: number;
}

export interface TeamBudget {
  team: Team;
  month: number;
  year: number;
  details: {
    total_players: number;
    players_team: number;
    players_other: number;
    paid_gym_sessions: number;
    coach_sessions: number;
    gym_per_person: number;
    coach_per_person: number;
    base_per_person: number;
  };
  base_per_person: number;
  charges: PlayerCharge[];
}

export interface BudgetInput {
  month: number;
  year: number;
  tariffs: Tariffs;
  events: BudgetEvent[]; // события обеих команд за месяц
  active: Record<Team, Player[]>;
  games: GameForBudget[]; // единый пул игр месяца; взнос атрибутируется по участнику
}

const isPaidGym = (e: BudgetEvent) => e.tags.GYM === 'PAID';
const isTrainingCoach = (e: BudgetEvent) =>
  e.tags.TYPE === 'TRAINING' && e.tags.COACH === 'PAID';

/**
 * Расчёт месячного бюджета для обеих команд.
 *
 * Зал (платный, по четвергам) делится на ВСЕХ активных игроков обеих команд:
 *   gym = ceil((кол-во_платных_залов * gym_price + locker) / всего_активных)
 * Тренер за тренировки — отдельно по командам:
 *   coach[team] = ceil(трен_команды * coach_per_session / активные_команды)
 * Взносы за игры начисляются персонально тем, кто играл — по всему пулу игр месяца,
 * независимо от команды-метки игры. Так игрок RED, сыгравший за BLACK, получает взнос
 * в свой (RED) бюджет: строка начисления есть только в его домашней команде.
 */
export function computeBudgets(input: BudgetInput): Record<Team, TeamBudget> {
  const { tariffs } = input;

  // Платные залы считаем по уникальным событиям (без двойного счёта).
  const paidGymUids = new Set(input.events.filter(isPaidGym).map((e) => e.uid));
  const paidGymSessions = paidGymUids.size;

  const activeRed = input.active.RED.length;
  const activeBlack = input.active.BLACK.length;
  const totalActive = activeRed + activeBlack;

  const gymTotalCost = paidGymSessions * tariffs.gym_paid_price + tariffs.locker_rent_price;
  const gymPerPerson = totalActive > 0 ? Math.ceil(gymTotalCost / totalActive) : 0;

  const build = (team: Team): TeamBudget => {
    const teamActive = input.active[team];
    const otherCount = team === 'RED' ? activeBlack : activeRed;

    const coachSessions = input.events.filter(
      (e) => e.team === team && isTrainingCoach(e),
    ).length;
    const coachTotal = coachSessions * tariffs.coach_per_session;
    const coachPerPerson = teamActive.length > 0 ? Math.ceil(coachTotal / teamActive.length) : 0;

    const basePerPerson = gymPerPerson + coachPerPerson;

    const charges: PlayerCharge[] = teamActive.map((player) => {
      const game = gameFeeForPlayer(player.id, input.games);
      return {
        player,
        base_amount: basePerPerson,
        game_amount: game,
        extra_amount: 0, // Разовые взносы назначаются в транзакции сохранения бюджета.
        extra_items: [],
        amount: basePerPerson + game,
      };
    });

    return {
      team,
      month: input.month,
      year: input.year,
      details: {
        total_players: totalActive,
        players_team: teamActive.length,
        players_other: otherCount,
        paid_gym_sessions: paidGymSessions,
        coach_sessions: coachSessions,
        gym_per_person: gymPerPerson,
        coach_per_person: coachPerPerson,
        base_per_person: basePerPerson,
      },
      base_per_person: basePerPerson,
      charges,
    };
  };

  return { RED: build('RED'), BLACK: build('BLACK') };
}
