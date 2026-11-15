-- Получатели разового сбора задаются независимо от правила начисления:
-- ALL — динамически все подходящие игроки, SELECTED — только сохранённый список.
alter table extra_fees
  add column recipient_scope text not null default 'ALL'
  check (recipient_scope in ('ALL', 'SELECTED'));

create table extra_fee_recipients (
  fee_id integer not null references extra_fees(id) on delete cascade,
  player_id integer not null references players(id) on delete cascade,
  primary key (fee_id, player_id)
);

