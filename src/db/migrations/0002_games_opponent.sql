-- Соперник в записи игры — для строки игры в сообщении бюджета.
alter table games add column if not exists opponent text;
