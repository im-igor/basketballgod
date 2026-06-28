-- Игроки команд
create table if not exists players (
  id            serial primary key,
  name          text not null,
  tg_login      text not null unique,           -- @login
  tg_user_id    bigint,                          -- проставляется при первом голосовании
  is_employee   boolean not null default false,
  team          text not null check (team in ('RED','BLACK')),
  active        boolean not null default true,
  active_from   date,
  active_to     date,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_players_team_active on players (team, active);

-- Тарифы (одна строка-конфиг)
create table if not exists tariffs (
  id                 int primary key default 1,
  coach_per_session  numeric not null default 5000,   -- тренер за тренировку
  coach_per_game     numeric not null default 5000,   -- тренер за игру
  gym_paid_price     numeric not null default 25500,  -- аренда платного зала (Чт)
  locker_rent_price  numeric not null default 3000,   -- аренда шкафчика
  referee_default    numeric not null default 3500,   -- судья по умолчанию
  updated_at         timestamptz not null default now(),
  constraint tariffs_singleton check (id = 1)
);

-- Месячные бюджеты (на команду/месяц)
create table if not exists budgets (
  id               serial primary key,
  team             text not null check (team in ('RED','BLACK')),
  month            int not null check (month between 1 and 12),
  year             int not null,
  chat_id          bigint,
  message_id       bigint,            -- id сообщения сбора в TG (для правок)
  total_per_player numeric,
  details          jsonb,             -- расшифровка расчёта
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (team, month, year)
);

-- Персональные начисления внутри бюджета
create table if not exists charges (
  id          serial primary key,
  budget_id   int not null references budgets(id) on delete cascade,
  player_id   int references players(id) on delete set null,
  tg_login    text not null,
  name        text,
  base_amount numeric not null default 0,   -- зал + тренер
  game_amount numeric not null default 0,   -- взносы за игры
  amount      numeric not null default 0,   -- итого к оплате
  paid        boolean not null default false,
  paid_at     timestamptz,
  unique (budget_id, tg_login)
);

-- Сессии опросов (одно событие = один опрос)
create table if not exists poll_sessions (
  id           serial primary key,
  poll_id      text unique,                 -- telegram poll.id
  event_uid    text,
  team         text not null check (team in ('RED','BLACK')),
  chat_id      bigint not null,
  message_id   bigint,
  thread_id    bigint,
  question     text,
  options      jsonb,
  event_start  timestamptz,
  created_at   timestamptz not null default now()
);

-- Голоса в опросах (для понимания «кто придёт»)
create table if not exists poll_votes (
  id          serial primary key,
  poll_id     text not null references poll_sessions(poll_id) on delete cascade,
  tg_user_id  bigint not null,
  tg_username text,
  full_name   text,
  option_ids  int[] not null default '{}',
  voted_at    timestamptz not null default now(),
  unique (poll_id, tg_user_id)
);

-- Сыгранные игры и взносы за них
create table if not exists games (
  id             serial primary key,
  event_uid      text,
  team           text not null check (team in ('RED','BLACK','MIXED')),
  played_on      date,
  stat_url       text,
  fee_per_player numeric,                   -- тренер за игру / число сыгравших
  participants   jsonb,                     -- [{name, tg_login?, matched_player_id?}]
  month          int,
  year           int,
  created_at     timestamptz not null default now()
);
