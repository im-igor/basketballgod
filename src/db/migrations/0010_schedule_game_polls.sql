-- Голосовалки для игр, которые появились после регулярной рассылки.
alter table cron_config
  add column if not exists schedule_import_send_polls boolean not null default false;

-- Настройка по умолчанию выключена. После осознанного включения она также закроет
-- уже существующие будущие игры, для которых регулярный cron не успел создать опрос.
alter table scheduled_games
  add column if not exists poll_pending boolean not null default false,
  add column if not exists poll_sent_at timestamptz,
  add column if not exists poll_last_error text;

update scheduled_games game
set poll_sent_at = coalesce(game.poll_sent_at, (
  select min(poll.created_at)
  from poll_sessions poll
  where poll.team = game.team and poll.event_uid = game.calendar_event_id
))
where game.calendar_event_id is not null
  and exists (
    select 1 from poll_sessions poll
    where poll.team = game.team and poll.event_uid = game.calendar_event_id
  );

update scheduled_games game
set poll_pending = true
where game.game_date >= current_date
  and game.poll_sent_at is null;

alter table scheduled_games
  alter column poll_pending set default true;

create index if not exists idx_scheduled_games_poll_pending
  on scheduled_games (source, game_date)
  where poll_pending = true;
