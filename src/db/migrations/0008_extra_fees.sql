-- Разовый взнос: фиксированная сумма на человека, один раз за весь сбор.
create table extra_fees (
  id serial primary key,
  title text not null check (length(trim(title)) between 1 and 120),
  amount_per_player numeric(12,2) not null check (amount_per_player > 0),
  team text not null check (team in ('RED', 'BLACK', 'BOTH')),
  mode text not null check (mode in ('PLAYED', 'BUDGET')),
  league text not null check (league in ('ANY', 'MLBL', 'LCHB')),
  start_period int not null check (start_period between 202401 and 210012 and start_period % 100 between 1 and 12),
  end_period int check (end_period >= start_period and end_period <= 210012 and end_period % 100 between 1 and 12),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (mode = 'PLAYED' or (league = 'ANY' and end_period is null))
);

-- История начислений не зависит от оплаты: долг не начисляется заново в другом месяце.
create table extra_fee_allocations (
  id serial primary key,
  fee_id int not null references extra_fees(id) on delete restrict,
  player_id int references players(id) on delete set null,
  budget_id int not null references budgets(id) on delete cascade,
  tg_login text not null,
  title text not null,
  amount numeric(12,2) not null check (amount > 0),
  unique (fee_id, player_id),
  unique (fee_id, tg_login)
);
create index on extra_fee_allocations (budget_id);

alter table charges add column extra_amount numeric not null default 0;
alter table charges add column extra_items jsonb not null default '[]';
