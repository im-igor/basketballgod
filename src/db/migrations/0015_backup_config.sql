create table if not exists backup_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  frequency text not null default 'weekly' check (frequency in ('daily', 'weekly', 'monthly')),
  weekday int not null default 1 check (weekday between 1 and 7),
  month_day int not null default 1 check (month_day between 1 and 28),
  run_time text not null default '04:12' check (run_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  subdir text not null default '',
  keep_count int not null default 2 check (keep_count between 1 and 100),
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

insert into backup_config (id) values (1) on conflict (id) do nothing;
