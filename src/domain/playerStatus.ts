import type { Player, PlayerStatus } from '../db/types.js';

export const PLAYER_STATUSES: Record<PlayerStatus, string> = {
  RED: 'Red',
  BLACK: 'Black',
  BOTH: 'Black/Red',
  NONE: 'Active',
  INACTIVE: 'Non-active',
};

export function isPlayerStatus(value: unknown): value is PlayerStatus {
  return typeof value === 'string' && Object.hasOwn(PLAYER_STATUSES, value);
}

export function playerStatus(player: Pick<Player, 'team' | 'active'>): PlayerStatus {
  return player.active ? player.team : 'INACTIVE';
}

export function playerStatusLabel(player: Pick<Player, 'team' | 'active'>): string {
  return PLAYER_STATUSES[playerStatus(player)];
}
