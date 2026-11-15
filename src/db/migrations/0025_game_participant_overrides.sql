create table if not exists game_participant_overrides (
  id                bigserial primary key,
  scheduled_game_id bigint not null references scheduled_games(id) on delete cascade,
  from_player_id    integer not null references players(id) on delete cascade,
  to_player_id      integer not null references players(id) on delete cascade,
  reason            text not null,
  created_at        timestamptz not null default now(),
  unique (scheduled_game_id, from_player_id),
  check (from_player_id <> to_player_id)
);

comment on table game_participant_overrides is
  'Audited one-off substitutions: protocol roster identity -> player who actually played and pays the fee.';
