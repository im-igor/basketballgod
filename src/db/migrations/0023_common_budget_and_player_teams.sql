-- С декабря-2026 сборы публикуются единым бюджетом; исторические RED/BLACK
-- бюджеты остаются неизменными. Игрок может состоять в обеих командах.

alter table players drop constraint if exists players_team_check;
alter table players add constraint players_team_check check (team in ('RED', 'BLACK', 'BOTH'));

alter table budgets drop constraint if exists budgets_team_check;
alter table budgets add constraint budgets_team_check check (team in ('RED', 'BLACK', 'COMMON'));

-- Снимок заявки нужен, чтобы строка уже собранного бюджета не меняла смысл
-- после перевода игрока между командами.
alter table charges add column if not exists team_badge text;
