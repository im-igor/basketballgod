insert into tags (tag_key, tag_value, description, sort_order)
values ('INVOLVED', 'MIXED', 'Участники из обеих команд', 45)
on conflict (tag_key, tag_value) do nothing;
