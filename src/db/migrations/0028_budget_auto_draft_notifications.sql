create table if not exists budget_auto_draft_notifications (
  month integer not null check (month between 1 and 12),
  year integer not null check (year between 2024 and 2100),
  fingerprint text not null,
  status text not null check (status in ('sending', 'sent', 'failed')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  primary key (month, year)
);
