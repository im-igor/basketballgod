-- Окно последнего планового запуска опросов по играм.
-- Внеочередная рассылка после импорта использует именно его, а не новый горизонт
-- от момента парсинга.
create table if not exists cron_job_windows (
  job_key            text primary key,
  window_started_at  timestamptz not null,
  window_until       timestamptz not null,
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),
  constraint cron_job_windows_order check (window_until > window_started_at)
);
