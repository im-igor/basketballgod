-- Наблюдения протоколов не являются начислениями. Ошибка сбрасывает стабильность.
create table game_stats_checks (
  scheduled_game_id bigint primary key references scheduled_games(id) on delete cascade,
  fingerprint text,
  stable_since timestamptz,
  checked_at timestamptz not null,
  plan jsonb,
  error text
);

alter table games add column automatic_stats_fingerprint text;
