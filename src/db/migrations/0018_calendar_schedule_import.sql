alter table scheduled_games drop constraint scheduled_games_source_check;
alter table scheduled_games add constraint scheduled_games_source_check
  check (source in ('LCHB', 'MLBL', 'CALENDAR'));
create index if not exists idx_scheduled_games_calendar_event
  on scheduled_games (team, calendar_event_id);
