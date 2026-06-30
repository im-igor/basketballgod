-- Черновики опросов: создаются командой /poll и редактируются в личке у админа
-- (текст, варианты, форвард, пропуск), затем публикуются в чат по одному.
create table if not exists poll_drafts (
  id          serial primary key,
  team        text not null check (team in ('RED','BLACK')),
  event_uid   text,
  question    text not null,
  options     jsonb not null,
  event_start timestamptz,
  is_training boolean not null default false,  -- TYPE=TRAINING (подсказка и дефолт форварда)
  forward     boolean not null default false,  -- форвардить ли в чат другой команды
  status      text not null default 'pending'  -- pending | sent | skipped
              check (status in ('pending','sent','skipped')),
  poll_id     text,                            -- telegram poll.id после публикации
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
