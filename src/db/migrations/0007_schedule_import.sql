-- Матчи, импортированные со страниц расписания лиг.
-- Это отдельная сущность от `games`: `games` хранит уже сыгранные матчи,
-- участников и взносы, а здесь лежит календарное расписание будущих игр.
create table if not exists scheduled_games (
  id                bigserial primary key,
  source            text not null check (source in ('LCHB', 'MLBL')),
  source_url        text not null,
  external_id       text not null,
  team              text not null check (team in ('RED', 'BLACK')),
  team_a            text not null,
  team_b            text not null,
  game_date         date not null,
  game_time         time,
  location          text,
  details_url       text,
  calendar_event_id text,
  -- null = по умолчанию тренер будет; при конфликте null означает «нужно решить».
  coach_present     boolean,
  coach_override    boolean not null default false,
  coach_conflict    boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source, external_id)
);

create index if not exists idx_scheduled_games_date
  on scheduled_games (game_date, game_time);
create index if not exists idx_scheduled_games_team_date
  on scheduled_games (team, game_date);
