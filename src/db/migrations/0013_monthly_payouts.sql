-- Итоговый снимок выплат формируется один раз в конце месяца. Он не должен
-- меняться при последующем редактировании тарифов, календаря или игр.
create table if not exists monthly_payouts (
  month                    int not null check (month between 1 and 12),
  year                     int not null,
  coach_amount             numeric not null,
  gym_amount               numeric not null,
  coach_training_sessions  int not null,
  coach_games              int not null,
  paid_gym_sessions        int not null,
  coach_per_session        numeric not null,
  coach_per_game           numeric not null,
  gym_paid_price           numeric not null,
  locker_rent_price        numeric not null,
  coach_items              jsonb not null default '[]'::jsonb,
  gym_items                jsonb not null default '[]'::jsonb,
  calculated_at            timestamptz not null default now(),
  notified_at              timestamptz,
  primary key (year, month)
);
