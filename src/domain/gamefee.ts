import type { GameParticipant } from '../db/types.js';

/**
 * Взнос за игру на одного сыгравшего.
 * Для TYPE=GAME это тренер за игру (coach_per_game), для TYPE=FRIENDLY — судья.
 * Делится на количество вышедших на паркет (тех, у кого минуты > 0).
 */
export function feePerPlayer(totalFee: number, playedCount: number): number {
  if (playedCount <= 0) return 0;
  return Math.ceil(totalFee / playedCount);
}

/** Сумма взносов за игры конкретного игрока (по совпадению matched_player_id). */
export function gameFeeForPlayer(
  playerId: number,
  games: { fee_per_player: number | null; participants: GameParticipant[] }[],
): number {
  let sum = 0;
  for (const g of games) {
    const played = g.participants.some((p) => p.matched_player_id === playerId);
    if (played) sum += g.fee_per_player ?? 0;
  }
  return sum;
}
