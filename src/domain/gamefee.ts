import type { GameParticipant, Tariffs } from '../db/types.js';

/**
 * Взнос за игру на одного сыгравшего.
 * Для TYPE=GAME это тренер за игру (coach_per_game), для TYPE=FRIENDLY — судья.
 * Делится на количество вышедших на паркет (тех, у кого минуты > 0).
 */
export function feePerPlayer(totalFee: number, playedCount: number): number {
  if (playedCount <= 0) return 0;
  return Math.ceil(totalFee / playedCount);
}

/**
 * Единая формула взноса за игру из пер-игровых флагов присутствия.
 * Тренер был → +coach_per_game; судья был → +referee_default. Делится на сыгравших.
 * Используется всеми путями регистрации/пересчёта, чтобы логика не расходилась.
 */
export function computeGameFee(
  tariffs: Pick<Tariffs, 'coach_per_game' | 'referee_default'>,
  flags: { coach_present: boolean; judge: boolean },
  playedCount: number,
): number {
  const total =
    (flags.coach_present ? tariffs.coach_per_game : 0) + (flags.judge ? tariffs.referee_default : 0);
  return feePerPlayer(total, playedCount);
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
