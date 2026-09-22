import { z } from 'zod';
import type { ExtraFee, ExtraFeeAllocation, ExtraFeeItem, Game, Team } from '../db/types.js';
import { gameStatsRef } from '../gamefee/parser.js';

const period = z.string().regex(/^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/)
  .transform((v) => Number(v.replace('-', '')))
  .refine((v) => v >= 202401, 'Период должен быть не раньше 2024 года');

export const extraFeeForm = z.object({
  title: z.string().trim().min(1).max(120),
  amount_per_player: z.coerce.number().finite().positive().max(9999999999.99)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.0001, 'Не более двух знаков после запятой'),
  team: z.enum(['RED', 'BLACK', 'BOTH']),
  mode: z.enum(['PLAYED', 'BUDGET']),
  league: z.enum(['ANY', 'MLBL', 'LCHB']),
  start_period: period,
  end_period: z.union([z.literal(''), period]).optional().transform((v) => v || null),
}).superRefine((v, ctx) => {
  if (v.mode === 'PLAYED' && v.end_period !== null && v.end_period < v.start_period) {
    ctx.addIssue({ code: 'custom', path: ['end_period'], message: 'Конец сбора раньше начала' });
  }
}).transform((v) => ({
  ...v,
  league: v.mode === 'BUDGET' ? 'ANY' as const : v.league,
  end_period: v.mode === 'BUDGET' ? null : v.end_period,
}));

export type ExtraFeeInput = z.infer<typeof extraFeeForm>;

/** Денежные суммы складываем в копейках. */
export function sumMoney(amounts: number[]): number {
  return amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0) / 100;
}

function gameMatches(fee: ExtraFee, game: Game): boolean {
  if (fee.team !== 'BOTH' && game.team !== fee.team) return false;
  if (fee.league === 'ANY') return true;
  if (!game.stat_url) return false;
  try {
    return gameStatsRef(game.stat_url).source === fee.league;
  } catch {
    return false;
  }
}

/**
 * Назначение закреплено за бюджетом до его удаления. Пересборка, архивирование
 * сбора и изменение состава протокола не переносят уже начисленный долг.
 * Для PLAYED команда — команда игры; начисление идёт в домашний бюджет игрока.
 */
export function extraFeesForPlayer(input: {
  playerId: number | null;
  login: string;
  team: Team;
  budgetId: number;
  period: number;
  fees: ExtraFee[];
  allocations: ExtraFeeAllocation[];
  games: Game[];
}): ExtraFeeItem[] {
  const items: ExtraFeeItem[] = [];
  for (const fee of input.fees) {
    const existing = input.allocations.find((a) => a.fee_id === fee.id && (
      (input.playerId !== null && a.player_id === input.playerId) ||
      a.tg_login.toLowerCase() === input.login.toLowerCase()
    ));
    if (existing) {
      if (existing.budget_id === input.budgetId) {
        items.push({ fee_id: existing.fee_id, title: existing.title, amount: existing.amount });
      }
      continue;
    }
    if (input.playerId === null || !fee.active || input.period < fee.start_period ||
        (fee.end_period !== null && input.period > fee.end_period)) continue;

    const eligible = fee.mode === 'BUDGET'
      ? input.period === fee.start_period && (fee.team === 'BOTH' || fee.team === input.team)
      : input.games.some((g) => g.year !== null && g.month !== null &&
          g.year * 100 + g.month === input.period && gameMatches(fee, g) &&
          g.participants.some((p) => p.matched_player_id === input.playerId));
    if (eligible) items.push({ fee_id: fee.id, title: fee.title, amount: fee.amount_per_player });
  }
  return items;
}
