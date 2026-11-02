-- Старые снимки ошибочно включали игры по месяцу сбора взносов.
-- Однократно исправляем только игровые строки по фактической дате игры,
-- используя тариф самого снимка. Тренировки, зал, корректировки и взносы
-- игроков не пересчитываются. notified_at сохраняется: повторной рассылки нет.
with repaired as (
  select p.year, p.month,
    coalesce((
      select jsonb_agg(item order by item->>'date' nulls last, position)
      from (
        select item, ordinality as position
        from jsonb_array_elements(p.coach_items) with ordinality as old(item, ordinality)
        where item->>'kind' <> 'GAME'
        union all
        select jsonb_build_object(
          'kind', 'GAME', 'date', g.played_on,
          'label', 'Игра' || case when coalesce(g.opponent, '') <> '' then ' с ' || g.opponent else '' end,
          'amount', p.coach_per_game
        ) || case when g.team = 'MIXED' then '{}'::jsonb else jsonb_build_object('team', g.team) end,
        g.id::bigint
        from games g
        where g.coach_present and (
          (g.played_on >= make_date(p.year, p.month, 1)
           and g.played_on < make_date(p.year, p.month, 1) + interval '1 month')
          or (g.played_on is null and g.month = p.month and g.year = p.year)
        )
      ) items
    ), '[]'::jsonb) as coach_items
  from monthly_payouts p
), totals as (
  select r.*,
    (select count(*) from jsonb_array_elements(r.coach_items) item where item->>'kind' = 'GAME') as coach_games,
    (select coalesce(sum((item->>'amount')::numeric), 0) from jsonb_array_elements(r.coach_items) item) as coach_amount
  from repaired r
)
update monthly_payouts p
set coach_items = t.coach_items, coach_games = t.coach_games,
    coach_amount = t.coach_amount, calculated_at = now()
from totals t
where p.year = t.year and p.month = t.month
  and (p.coach_items is distinct from t.coach_items
       or p.coach_games is distinct from t.coach_games
       or p.coach_amount is distinct from t.coach_amount);
