export type Team = 'RED' | 'BLACK';

export interface Player {
  id: number;
  name: string;
  tg_login: string;
  tg_user_id: number | null;
  is_employee: boolean;
  team: Team;
  active: boolean;
  active_from: string | null;
  active_to: string | null;
  notes: string | null;
}

export interface Tariffs {
  coach_per_session: number;
  coach_per_game: number;
  gym_paid_price: number;
  locker_rent_price: number;
  referee_default: number;
}

export interface Budget {
  id: number;
  team: Team;
  month: number;
  year: number;
  chat_id: number | null;
  message_id: number | null;
  total_per_player: number | null;
  details: BudgetDetails | null;
}

export interface BudgetDetails {
  total_players: number;
  players_team: number;
  players_other: number;
  paid_gym_sessions: number;
  coach_sessions: number;
  gym_per_person: number;
  coach_per_person: number;
  base_per_person: number;
}

export interface Charge {
  id: number;
  budget_id: number;
  player_id: number | null;
  tg_login: string;
  name: string | null;
  base_amount: number;
  game_amount: number;
  amount: number;
  paid: boolean;
  paid_at: string | null;
}

export interface GameParticipant {
  name: string;
  tg_login?: string;
  matched_player_id?: number;
}

export interface Game {
  id: number;
  event_uid: string | null;
  team: Team | 'MIXED';
  played_on: string | null;
  stat_url: string | null;
  fee_per_player: number | null;
  participants: GameParticipant[];
  month: number | null;
  year: number | null;
}
