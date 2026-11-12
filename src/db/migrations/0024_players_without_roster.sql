-- Активный участник общего бюджета может не иметь заявки ни за одну команду.
alter table players drop constraint if exists players_team_check;
alter table players add constraint players_team_check check (team in ('RED', 'BLACK', 'BOTH', 'NONE'));
