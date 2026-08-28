-- Пер-игровой учёт присутствия тренера и судьи.
-- Раньше взнос за игру всегда включал coach_per_game (авто-игры) либо задавался
-- флагами только у товарищеских. Теперь у КАЖДОЙ игры есть явные флаги, чтобы
-- отмечать «тренера не было» (расписания лиг RED/BLACK пересекаются) и пересчитывать
-- взнос. По умолчанию тренер был, судьи не было.
alter table games
  add column if not exists coach_present boolean not null default true,
  add column if not exists judge         boolean not null default false;
