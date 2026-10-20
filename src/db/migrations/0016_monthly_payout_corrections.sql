alter table monthly_payouts
  add column if not exists corrections jsonb not null default '[]'::jsonb;
