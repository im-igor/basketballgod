-- Расписание планировщика (одна строка-конфиг, как tariffs).
-- Источник правды — БД; вкладка `cron` в Google-таблице синхронизируется в обе стороны.
create table if not exists cron_config (
  id             int primary key default 1,
  timezone       text,
  poll_weekday   int,     -- 1=Пн … 7=Вс
  poll_time      text,    -- «ЧЧ:ММ»
  fixation_day   int,     -- день месяца 1..28
  fixation_time  text,
  budget_day     int,     -- день месяца 1..28
  budget_time    text,
  updated_at     timestamptz not null default now(),
  constraint cron_config_singleton check (id = 1)
);

-- Значения по умолчанию = дефолты из env (Europe/Moscow, пятница 12:00, фиксация 25-го 20:00, бюджет 26-го 20:00).
insert into cron_config (id, timezone, poll_weekday, poll_time, fixation_day, fixation_time, budget_day, budget_time)
values (1, 'Europe/Moscow', 5, '12:00', 25, '20:00', 26, '20:00')
on conflict (id) do nothing;

-- Справочник тегов календарных событий (документация словаря KEY=VALUE).
-- Не управляет валидацией парсинга (та остаётся на code-level enum в src/google/tags.ts),
-- служит человекочитаемой легендой и синхронизируется с вкладкой `Tags`.
create table if not exists tags (
  id          serial primary key,
  tag_key     text not null,
  tag_value   text not null default '',
  description text,
  sort_order  int not null default 0,
  unique (tag_key, tag_value)
);

-- Сид текущим словарём из EventTagsSchema.
insert into tags (tag_key, tag_value, description, sort_order) values
  ('TYPE',          'TRAINING',     'Тренировка',                                   10),
  ('TYPE',          'GAME',         'Официальная игра',                             11),
  ('TYPE',          'FRIENDLY',     'Товарищеская игра',                            12),
  ('GYM',           'PAID',         'Платный зал (входит в расчёт аренды)',         20),
  ('GYM',           'FREE',         'Бесплатный зал (Яндекс)',                      21),
  ('COACH',         'PAID',         'Тренер платный (входит в расчёт)',             30),
  ('COACH',         'FREE',         'Тренер бесплатный',                            31),
  ('INVOLVED',      'ALL_RED',      'Все активные игроки RED',                      40),
  ('INVOLVED',      'ALL_BLACK',    'Все активные игроки BLACK',                    41),
  ('INVOLVED',      'PLAYED_RED',   'Сыгравшие из RED',                             42),
  ('INVOLVED',      'PLAYED_BLACK', 'Сыгравшие из BLACK',                           43),
  ('INVOLVED',      'PLAYED_MIXED', 'Сыгравшие из обеих команд',                    44),
  ('REFEREE_PRICE', '<число>',      'Стоимость судейства, ₽ (пусто = дефолт из тарифов)', 50),
  ('NOTES',         '<текст>',      'Произвольная заметка к событию',               60)
on conflict (tag_key, tag_value) do nothing;
