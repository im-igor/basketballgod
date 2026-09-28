-- Старые окна считались как ровно N * 24 часа от запуска и могли отсечь игру
-- в последний день горизонта, если она начиналась позднее времени cron.
-- Расширяем текущее окно до полуночи после последнего календарного дня.
update cron_job_windows as job_window
set window_until = (
      ((job_window.window_started_at at time zone config.timezone)::date
        + config.poll_game_horizon_days + 1)::timestamp
      at time zone config.timezone
    ),
    updated_at = now()
from cron_config config
where job_window.job_key = 'game-polls'
  and config.poll_game_horizon_days > 0;
