-- Раздельные расписания опросов: тренировки (TYPE=TRAINING) и игры (GAME+FRIENDLY).
-- Раньше был один poll_weekday/poll_time и единый горизонт POLL_HORIZON_DAYS.
-- Теперь по каждому виду — свои день недели, время и горизонт (дней вперёд).

alter table cron_config
  add column if not exists poll_training_weekday      int,   -- 1=Пн … 7=Вс
  add column if not exists poll_training_time         text,  -- «ЧЧ:ММ»
  add column if not exists poll_training_horizon_days int,   -- окно опроса, дней
  add column if not exists poll_game_weekday          int,
  add column if not exists poll_game_time             text,
  add column if not exists poll_game_horizon_days     int;

-- Переносим текущее единое расписание в «тренировки».
update cron_config
set poll_training_weekday = poll_weekday,
    poll_training_time    = poll_time
where id = 1;

-- Досеиваем пустые поля дефолтами (пятница 12:00, горизонт 7 дней).
update cron_config
set poll_training_weekday      = coalesce(poll_training_weekday, 5),
    poll_training_time         = coalesce(poll_training_time, '12:00'),
    poll_training_horizon_days = coalesce(poll_training_horizon_days, 7),
    poll_game_weekday          = coalesce(poll_game_weekday, 5),
    poll_game_time             = coalesce(poll_game_time, '12:00'),
    poll_game_horizon_days     = coalesce(poll_game_horizon_days, 7)
where id = 1;

-- Старые единые поля больше не нужны.
alter table cron_config
  drop column if exists poll_weekday,
  drop column if exists poll_time;
