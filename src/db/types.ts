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

export interface CronConfig {
  timezone: string | null;
  // Опросы на тренировки (TYPE=TRAINING) — своё расписание и горизонт.
  poll_training_weekday: number | null; // 1=Пн … 7=Вс
  poll_training_time: string | null; // «ЧЧ:ММ»
  poll_training_horizon_days: number | null; // окно опроса, дней вперёд
  // Опросы на игры (TYPE=GAME|FRIENDLY) — отдельное расписание и горизонт.
  poll_game_weekday: number | null;
  poll_game_time: string | null;
  poll_game_horizon_days: number | null;
  fixation_day: number | null;
  fixation_time: string | null;
  budget_day: number | null;
  budget_time: string | null;
}

export interface Tag {
  id: number;
  tag_key: string;
  tag_value: string;
  description: string | null;
  sort_order: number;
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
  coach_sessions: number; // календарное число тренировок (для строки «N трен.»)
  gym_per_person: number;
  coach_per_person: number; // итог с учётом coach_delta
  base_per_person: number;
  // Ручные корректировки черновика (кнопками в личке):
  coach_delta?: number; // ± оплат тренера к календарному coach_sessions
  coach_note?: string | null; // комментарий к строке тренера
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
  opponent: string | null;
  played_on: string | null;
  stat_url: string | null;
  fee_per_player: number | null;
  participants: GameParticipant[];
  coach_present: boolean; // тренер был на игре → в взнос входит coach_per_game
  judge: boolean; // был судья → в взнос входит referee_default
  month: number | null;
  year: number | null;
}

export type ScheduleSource = 'LCHB' | 'MLBL';

/** Матч из расписания лиги; не смешивается с учётом сыгравших и взносов в `games`. */
export interface ScheduledGame {
  id: string;
  source: ScheduleSource;
  source_url: string;
  external_id: string;
  team: Team;
  team_a: string;
  team_b: string;
  game_date: string | Date;
  game_time: string | null;
  location: string | null;
  details_url: string | null;
  calendar_event_id: string | null;
  coach_present: boolean | null;
  coach_override: boolean;
  coach_conflict: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}
