-- Сверка расписания не только по внешнему ID, но и по фактическому матчу.
-- present_in_source отличает актуальную строку от старого ID, исчезнувшего у лиги;
-- duplicate_notified_at не даёт слать одно и то же предупреждение каждый cron.
alter table scheduled_games
  add column if not exists present_in_source boolean not null default true,
  add column if not exists duplicate_notified_at timestamptz;

create index if not exists idx_scheduled_games_fixture
  on scheduled_games (source, team, game_date, game_time);
