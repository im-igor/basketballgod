-- Управляем уведомлениями о выходе игроков из Telegram-чата через раздел «Крон».
-- По умолчанию сохраняем прежнее поведение: проверка включена.
alter table cron_config
  add column if not exists chat_member_check_enabled boolean not null default true;
