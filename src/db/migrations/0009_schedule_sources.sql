-- Постоянные источники расписаний и периодическая проверка обновлений.
alter table cron_config
  add column if not exists schedule_import_enabled boolean not null default false,
  add column if not exists schedule_import_interval_minutes int not null default 60;

alter table cron_config
  drop constraint if exists cron_config_schedule_import_interval;
alter table cron_config
  add constraint cron_config_schedule_import_interval check (
    schedule_import_interval_minutes in (15, 30, 60, 120, 240, 360, 720, 1440)
  );

create table if not exists schedule_sources (
  source                  text primary key check (source in ('LCHB', 'MLBL')),
  team                    text not null check (team in ('RED', 'BLACK')),
  url                     text not null,
  enabled                 boolean not null default true,
  last_checked_at         timestamptz,
  last_success_at         timestamptz,
  last_found              int,
  last_new                int,
  last_saved              int,
  last_calendar_synced    int,
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
