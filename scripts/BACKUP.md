# Бэкап и восстановление basketballgod

Весь **код** (включая миграции, `Dockerfile`, `docker-compose.yml`) хранится в GitHub и в
бэкап не входит. Бэкапится только то, чего в гите нет и что нельзя восстановить:

| Что | Где на сервере | Зачем |
|-----|----------------|-------|
| **Дамп БД** (`db.dump`) | docker-том `pgdata` → снимается через `pg_dump` | Игроки, бюджеты, начисления/оплаты, игры, опросы, `cron_config`, тарифы, теги. **Единственный** источник правды — Google-таблица данные не хранит (синк только БД → таблица). |
| **`.env`** | корень проекта | Токен бота, `ADMIN_PASSWORD`, `SESSION_SECRET`, ID чатов/календарей/таблицы, `TELEGRAM_API_ROOT`. |
| **`secrets/`** | корень проекта (монтируется как `/app/secrets:ro`) | JSON-ключ сервис-аккаунта Google — только если используешь файл, а не `GOOGLE_SERVICE_ACCOUNT_BASE64`. |

Скрипт [`backup.sh`](backup.sh) складывает всё это в один `basketballgod_ГГГГ-ММ-ДД_ЧЧММ.tar.gz`.

## Что внутри архива

```
db.dump         # дамп Postgres (custom format, pg_dump -Fc)
.env            # конфиг и секреты
secrets/        # ключ Google (если был)
MANIFEST.txt    # дата, хост, git-коммит на момент снятия
```

## Ручной запуск

```bash
cd ~/basketballgod          # каталог с docker-compose.yml
./scripts/backup.sh
```

Куда и сколько:
- Папка бэкапов — `~/basketballgod-backups` (переопределяется: `BACKUP_DIR=/mnt/backups ./scripts/backup.sh`).
- Хранится **2** последних копии (переопределяется: `KEEP=4 ./scripts/backup.sh`). Более старые удаляются автоматически.

Требования: контейнер `db` должен быть запущен (`docker compose up -d db`).

## Автозапуск раз в неделю (cron)

Открой crontab пользователя, под которым крутится проект:

```bash
crontab -e
```

Добавь строку — каждый **понедельник в 04:12** (нечётная минута, чтобы не совпадать с пиком):

```cron
12 4 * * 1 cd $HOME/basketballgod && ./scripts/backup.sh >> $HOME/basketballgod-backups/backup.log 2>&1
```

Проверить, что задача добавилась: `crontab -l`.
Проверить работу вручную, не дожидаясь понедельника: запусти команду из строки cron целиком.

> Скрипт сам дополняет `PATH`, чтобы `docker` находился в урезанном окружении cron.
> Лог каждого прогона пишется в `~/basketballgod-backups/backup.log`.

## Восстановление на новом (или переустановленном) сервере

```bash
# 1. Код — из GitHub.
git clone <repo-url> basketballgod
cd basketballgod

# 2. Распаковать нужный бэкап во временную папку.
mkdir /tmp/restore && tar -xzf /путь/basketballgod_2026-08-11_0412.tar.gz -C /tmp/restore

# 3. Вернуть конфиг и секреты.
cp /tmp/restore/.env .env
[ -d /tmp/restore/secrets ] && cp -R /tmp/restore/secrets ./secrets

# 4. Поднять ТОЛЬКО базу и дождаться готовности.
docker compose up -d db
until docker compose exec -T db pg_isready -U basketballgod; do sleep 1; done

# 5. Восстановить данные из дампа (пересоздаёт объекты, если они уже есть).
docker compose exec -T db pg_restore -U basketballgod -d basketballgod --clean --if-exists \
  < /tmp/restore/db.dump

# 6. Поднять приложение (миграции идемпотентны — доедут поверх без вреда).
docker compose up -d --build app

# 7. Проверить.
docker compose logs -f app        # ждём "[bot] long polling запущен …" и "[cron] расписание активно …"
rm -rf /tmp/restore
```

### Восстановить только БД (сервер жив, потеряли/испортили данные)

```bash
mkdir /tmp/restore && tar -xzf /путь/basketballgod_ДАТА.tar.gz -C /tmp/restore
docker compose exec -T db pg_restore -U basketballgod -d basketballgod --clean --if-exists \
  < /tmp/restore/db.dump
docker compose restart app
rm -rf /tmp/restore
```

> ⚠️ `--clean --if-exists` удалит текущее содержимое таблиц перед заливкой дампа — восстанавливаешь состояние на момент бэкапа, всё, что было позже, теряется.

## Проверка целостности архива (без восстановления)

```bash
tar -tzf basketballgod_ДАТА.tar.gz        # список файлов
tar -xzf basketballgod_ДАТА.tar.gz -O ./MANIFEST.txt   # дата/коммит снятия
```
