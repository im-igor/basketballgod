-- ACTIVE: взнос начисляется активному участнику команды в первый собранный
-- для него бюджет, начиная с start_period. История назначений остаётся
-- источником правды и не допускает повторного начисления.
alter table extra_fees drop constraint extra_fees_mode_check;
alter table extra_fees add constraint extra_fees_mode_check
  check (mode in ('PLAYED', 'BUDGET', 'ACTIVE'));

-- Переводим действующий медицинский сбор без создания нового fee_id:
-- уже внесённые назначения сохраняются, а новые игроки BLACK получат взнос
-- в ближайшем бюджете, в котором они будут участвовать.
update extra_fees
set mode = 'ACTIVE', league = 'ANY', end_period = null
where team = 'BLACK'
  and mode = 'PLAYED'
  and league = 'MLBL'
  and lower(trim(title)) like 'меддопуск млбл%';
