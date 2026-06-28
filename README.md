# 🏀 basketballgod

Telegram-бот + лёгкая админ-панель для двух любительских баскетбольных команд **Red** и **Black**: еженедельные опросы по тренировкам/играм из Google Calendar, ежемесячные бюджеты, взносы за игры и учёт оплат.

Переписан с нуля (TypeScript) с n8n-прототипа. Готов к запуску в контейнере (Docker / Yandex Cloud).

---

## Возможности

- **Опросы (Пт 12:00, Europe/Moscow).** Читает события из обоих Google-календарей на ближайшие 7 дней и шлёт неанонимные опросы в чаты команд (топик «Голосовалки и сборы»). Тренировки дублируются в чат другой команды (forward). Голоса собираются — видно поимённо, кто придёт.
- **Бюджеты (25-е число).** Считает помесячный сбор: аренда платного зала делится на всех активных, тренер за тренировки — по командам, плюс **персональные взносы за игры**. Перед расчётом подтягивает актуальный состав из Google-таблицы и присылает **черновик в личку администратору** (отдельно по каждой команде). Админ проверяет и кнопкой «Опубликовать в чат» отправляет сбор в чат команды.
- **Взносы за игры.** Парсит статистику матча с сайта чемпионата (без LLM), считает `тариф / число сыгравших`, сопоставляет игроков с ростером по фамилии.
- **Учёт оплат.** Отметка «+» напротив игрока (в боте или в панели) обновляет исходное сообщение сбора.
- **Напоминания должникам.**
- **Игроки = Google-таблица.** Состав ведётся в таблице `Players` (источник правды): правки из бота и админки пишутся в таблицу, а в БД состав подтягивается импортом (см. «Модель данных»).
- **Админ-панель.** Адаптивная (мобайл/десктоп), под паролем: игроки (правят таблицу), тарифы, бюджеты, оплаты, должники, ручной запуск опросов.

## Стек

Node.js 20 · TypeScript · [grammY](https://grammy.dev) (Telegram) · [googleapis](https://github.com/googleapis/google-api-nodejs-client) (Calendar/Sheets) · PostgreSQL (`pg`) · [Fastify](https://fastify.dev) (панель/webhook) · `node-cron` · `zod` · `node-html-parser`. Без тяжёлых фреймворков и лишних зависимостей.

## Структура проекта

```
basketballgod/
├─ src/
│  ├─ index.ts               # bootstrap: миграции → http → бот → планировщик
│  ├─ config/env.ts          # валидация окружения (zod)
│  ├─ db/
│  │  ├─ pool.ts · migrator.ts · migrate.ts · types.ts
│  │  ├─ migrations/0001_init.sql
│  │  └─ repos/{players,tariffs,budgets,polls,games}.repo.ts
│  ├─ google/
│  │  ├─ auth.ts             # сервис-аккаунт
│  │  ├─ calendar.ts         # чтение событий
│  │  ├─ sheets.ts           # чтение/запись листа игроков Players
│  │  └─ tags.ts             # парсер тегов TYPE/GYM/COACH/INVOLVED/...
│  ├─ domain/                # чистая логика (бюджет, активность, взносы, сообщения, даты)
│  ├─ gamefee/parser.ts      # парсер статистики матча
│  ├─ services/              # оркестрация (poll, budget, gameFee, notify, playersImport)
│  ├─ bot/                   # grammY: команды, allowlist, сбор голосов, публикация бюджета
│  ├─ scheduler/cron.ts      # Пт 12:00 (опросы), 25-е (импорт игроков + черновик бюджета)
│  ├─ http/                  # Fastify: админ-панель + webhook + healthz
│  └─ util/                  # logger, args
├─ scripts/                  # import-players.ts, copy-assets.mjs
├─ Dockerfile · docker-compose.yml · .env.example · README.md
```

---

## Модель данных (игроки)

**Источник правды по составу — Google-таблица, вкладка `Players`** (колонки `A:I`:
`№ | name | tg_login | employee | team | active | active_from | active_to | notes`).

```
Бот (/player_add, /player_set, /active) и админка  ──►  пишут в Google-таблицу
Google-таблица (источник правды)                   ──►  импорт ──►  Postgres (кэш для расчётов)
   триггеры импорта:  cron 25-го (перед бюджетом) │ /sync_players │ кнопка «Импортировать в БД»
Postgres                                           ──►  расчёты: бюджет, должники, оплаты
```

- Правки игроков (бот/админка) меняют **таблицу**, а не БД напрямую.
- В Postgres состав попадает **импортом**: автоматически перед сбором бюджета 25-го числа, по команде
  `/sync_players` или по кнопке «Импортировать в БД» в админке.
- Игрок, **удалённый из таблицы**, при импорте **деактивируется** в БД (`active=NO`) — строка и история
  (взносы, голоса) сохраняются.
- Форматы ячеек: `employee` → `TRUE/FALSE`, `active` → `YES/NO`, даты → `дд.мм.гггг`.

> Разовый CLI-импорт для первичного засева: `docker compose exec app node dist/scripts/import-players.js`.

---

## Подготовка внешних сервисов

### 1. Telegram
1. Создай бота у [@BotFather](https://t.me/BotFather), возьми токен → `TELEGRAM_BOT_TOKEN`.
   > ⚠️ Старый токен из n8n утёк в выгруженный JSON — **отзови его** (`/revoke`).
2. Добавь бота в чаты команд **админом** (право отправлять опросы и сообщения).
3. Узнай `chat_id` и `message_thread_id` топика «Голосовалки и сборы» → `RED_CHAT_ID/RED_THREAD_ID`, `BLACK_CHAT_ID/BLACK_THREAD_ID`.
4. Свой Telegram `user_id` → `ADMIN_TG_IDS` (команды бота доступны только из этого списка).

### 2. Google (сервис-аккаунт)
1. В Google Cloud Console создай **service account**, включи **Google Calendar API** и **Google Sheets API**, скачай JSON-ключ.
2. **Расшарь оба календаря и таблицу** на email сервис-аккаунта (`client_email` из ключа): календари — с доступом «Просмотр», а **таблицу `Players` — «Редактор»** (бот пишет в неё). Без прав «Редактор» запись вернёт `403`.
3. Передай ключ приложению одним из способов:
   - файлом: `GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json` (положи в `./secrets/`);
   - или строкой: `GOOGLE_SERVICE_ACCOUNT_BASE64=$(base64 -i service-account.json)` (удобно для Yandex Lockbox).

### 3. Теги событий в календаре
В описании события указывай теги (по ним считается бюджет):

```
TYPE=TRAINING        # TRAINING | GAME | FRIENDLY
GYM=PAID             # PAID | FREE
COACH=PAID           # PAID | FREE
INVOLVED=ALL_BLACK   # ALL_RED | ALL_BLACK | PLAYED_RED | PLAYED_BLACK | PLAYED_MIXED
REFEREE_PRICE=3500   # опционально (для FRIENDLY)
NOTES="..."          # опционально
```

---

## Переменные окружения

Скопируй `.env.example` → `.env` и заполни. Ключевые: `TELEGRAM_BOT_TOKEN`, `*_CHAT_ID`/`*_THREAD_ID`, `ADMIN_TG_IDS`, `GOOGLE_CALENDAR_RED/BLACK`, `GOOGLE_SHEET_ID` (таблица игроков), ключ Google, `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`. Расписание и тарифы имеют дефолты (см. файл).

---

## Запуск

### Вариант А: Docker Compose (рекомендуется)

```bash
cp .env.example .env          # заполни значения
mkdir -p secrets              # положи service-account.json, если ключ файлом
docker compose up -d --build  # поднимет postgres + приложение
docker compose logs -f app    # логи
```

Миграции прогоняются автоматически при старте. После первого запуска — разовый импорт игроков из Google Sheet:

```bash
docker compose exec app node dist/scripts/import-players.js
```

Админ-панель: `http://localhost:3000` (логин/пароль из `.env`).

### Вариант Б: локально (Node 20)

```bash
npm install
cp .env.example .env          # DATABASE_URL → твой Postgres
npm run migrate
npm run dev                   # tsx watch
# или прод-сборка:
npm run build && npm start
```

### Сборка отдельного Docker-образа

```bash
docker build -t basketballgod:latest .
docker run --env-file .env -p 3000:3000 \
  -v "$PWD/secrets:/app/secrets:ro" basketballgod:latest
```

---

## Пошаговый деплой на готовую виртуалку (Compute VM) через Docker Compose

Самый простой путь: всё (приложение + PostgreSQL) поднимается на одной ВМ через `docker compose`. Managed-БД при этом **не нужна** — Postgres работает в контейнере. Long polling, публичный URL не требуется.

> Если хочешь вынести БД в **Managed Service for PostgreSQL** — см. отдельный блок ниже после основной инструкции.

### Шаг 0. Что нужно заранее
- Виртуалка в Yandex Cloud с Ubuntu/Debian и доступом по SSH (логин обычно `yc-user` или твой).
- Токен Telegram-бота, `chat_id`/`thread_id` чатов, JSON-ключ Google service account (см. «Подготовка внешних сервисов» выше).

### Шаг 1. Зайди на ВМ по SSH
```bash
ssh <user>@<публичный_IP_вм>
```

### Шаг 2. Установи Docker и Docker Compose
```bash
sudo apt-get update
curl -fsSL https://get.docker.com | sudo sh
# чтобы запускать docker без sudo (перелогинься после этой команды):
sudo usermod -aG docker $USER
```
Проверка: `docker --version` и `docker compose version`.

### Шаг 3. Доставь проект на ВМ
Вариант с git (если код в репозитории):
```bash
git clone <url_репозитория> basketballgod
cd basketballgod
```
Или скопируй папку со своей машины (без `node_modules`/`dist` — они соберутся в образе):
```bash
# с локальной машины:
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./basketballgod/ <user>@<IP>:~/basketballgod/
```

### Шаг 4. Подготовь `.env`
```bash
cp .env.example .env
nano .env
```
Заполни обязательное: `TELEGRAM_BOT_TOKEN`, `*_CHAT_ID`/`*_THREAD_ID`, `ADMIN_TG_IDS`, `GOOGLE_CALENDAR_RED/BLACK`, `ADMIN_PASSWORD`, `SESSION_SECRET`.

> ⚠️ **`DATABASE_URL` в `.env` НЕ трогай** — для compose он переопределяется на `db:5432` прямо в [docker-compose.yml](docker-compose.yml) (строка 23). Менять нужно только при переходе на managed-БД.

### Шаг 5. Положи ключ Google
Файл `service-account.json` — это JSON-ключ **сервисного аккаунта Google**, который ты создаёшь в [Google Cloud Console](https://console.cloud.google.com/) (подробно — в разделе [«2. Google (сервис-аккаунт)»](#2-google-сервис-аккаунт) выше). Кратко: создай service account, включи Calendar API + Sheets API, во вкладке **Keys** скачай ключ в формате JSON, и расшарь на его `client_email` календари (доступ «Просмотр») и **таблицу `Players` с доступом «Редактор»** (бот в неё пишет).

Скачанный файл переименуй в `service-account.json` и положи в папку `secrets/` на ВМ:
```bash
mkdir -p secrets
# скопируй service-account.json в ./secrets/  (scp/rsync/nano)
```
В `.env` оставь `GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/service-account.json`.
(Альтернатива без файла: положи весь ключ в `GOOGLE_SERVICE_ACCOUNT_BASE64=$(base64 -i service-account.json)`.)

### Шаг 6. Подними контейнеры
```bash
docker compose up -d --build
docker compose ps           # оба сервиса должны быть healthy/running
docker compose logs -f app  # смотрим лог запуска (миграции прогонятся сами)
```

### Шаг 7. Разовый импорт игроков из Google Sheet
```bash
docker compose exec app node dist/scripts/import-players.js
```

### Шаг 8. Проверь работу
```bash
curl http://localhost:3000/healthz   # должен ответить ok
```
Админ-панель: `http://<публичный_IP_вм>:3000` (логин/пароль из `.env`).

> Чтобы панель открывалась снаружи — в **security group** виртуалки разреши входящий TCP на порт `3000` (или повесь nginx/Caddy с HTTPS и проксируй на `3000`). Для самого Telegram-бота открывать порты не нужно — он работает по long polling (исходящие соединения).

### Эксплуатация
```bash
docker compose logs -f app          # логи
docker compose restart app          # перезапуск после смены .env
docker compose up -d --build app    # пересборка после git pull / нового кода
docker compose down                  # остановить (данные БД сохранятся в volume pgdata)
```
Бэкап БД:
```bash
docker compose exec db pg_dump -U basketballgod basketballgod > backup_$(date +%F).sql
```

---

### (Опционально) Вынести БД в Managed Service for PostgreSQL

Если не хочешь держать Postgres на ВМ:

1. Создай кластер **Managed Service for PostgreSQL**, базу и пользователя.
2. В [docker-compose.yml](docker-compose.yml) **удали сервис `db`**, блок `depends_on` у `app` и `volumes: pgdata`.
3. В `app` убери переопределение `DATABASE_URL` из секции `environment` (строки 22–23), чтобы значение бралось из `.env`.
4. В `.env` пропиши строку подключения к managed-кластеру с обязательным SSL:
   ```
   DATABASE_URL=postgres://<user>:<password>@<host>.mdb.yandexcloud.net:6432/<db>?sslmode=require
   ```
5. Скачай корневой сертификат YC (`~/.postgresql/root.crt`) на ВМ — он нужен для `sslmode=verify-full`; для `sslmode=require` достаточно строки выше.
6. `docker compose up -d --build` — миграции прогонятся в managed-БД при старте.

---

## Деплой обновлений через GitHub

Рекомендуемый способ доставлять новый код на ВМ: пушим в GitHub-репозиторий → на ВМ `git pull` →
пересборка контейнера. Секреты (`.env`, `secrets/`) **не** попадают в репозиторий — они уже в
[.gitignore](.gitignore) и `.dockerignore`.

### Один раз: завести репозиторий (на локальной машине)
```bash
cd basketballgod
git init                      # если ещё не git-репозиторий
git add .
git commit -m "basketballgod: игроки из Google-таблицы, черновик бюджета"
# создать приватный репозиторий и запушить (нужен установленный gh):
gh repo create basketballgod --private --source=. --remote=origin --push
# либо вручную: создай репозиторий на github.com и
#   git remote add origin git@github.com:<user>/basketballgod.git
#   git branch -M main && git push -u origin main
```

> Проверь, что в коммит **не** попали `.env` и `secrets/`: `git status` и `git ls-files | grep -E 'env|secrets'` — должно быть пусто.

### Один раз: получить репозиторий на ВМ
Если на ВМ уже лежит папка `~/basketballgod` (например, копировалась через `rsync`), привяжи её к
репозиторию или клонируй заново. Чистый клон (рекомендуется):
```bash
ssh <user>@<IP_вм>
git clone git@github.com:<user>/basketballgod.git ~/basketballgod   # или https-URL
cd ~/basketballgod
cp .env.example .env && nano .env      # перенеси значения из старого .env
mkdir -p secrets                       # положи service-account.json (chmod 600)
```

### Каждое обновление
**Локально:**
```bash
git add -A && git commit -m "что изменил" && git push
```
**На ВМ:**
```bash
cd ~/basketballgod
git pull
docker compose up -d --build app       # пересобрать и перезапустить только приложение
docker compose logs -f app             # проверить запуск (миграции прогонятся сами)
```

После выката новой версии с интеграцией таблицы:
1. дай сервис-аккаунту доступ **«Редактор»** на таблицу `Players` (иначе запись вернёт `403`);
2. при необходимости первичного засева БД — `docker compose exec app node dist/scripts/import-players.js`;
3. убедись, что каждый админ из `ADMIN_TG_IDS` нажал **Start** в личке бота (для черновиков бюджета).

---

## Команды бота (только админы из `ADMIN_TG_IDS`)

| Команда | Действие |
|---|---|
| `/player_add Имя \| @login \| RED\|BLACK` | добавить игрока в таблицу |
| `/player_set @login поле=значение …` | изменить поля игрока в таблице (`name`, `team`, `employee`, `active`, `from`, `to`, `notes`) |
| `/player_del @login` | удалить игрока из таблицы |
| `/active @login yes\|no` | активность игрока на следующий месяц (пишет в таблицу) |
| `/sync_players` | импортировать таблицу игроков в БД |
| `/budget [MM YYYY]` | собрать бюджет → **черновик в личку** (по умолчанию след. месяц) |
| `/game_fee url1 url2 …` | посчитать взносы за игру(ы) по статистике |
| `/debtors [MM YYYY]` | напомнить должникам (по умолчанию текущий месяц) |
| `/pay @login MM YYYY` | отметить оплату игрока |
| `/poll` | вручную разослать опросы на неделю |
| `/help` | справка |

> **Бюджет → публикация.** `/budget` (и крон 25-го) сначала импортирует состав из таблицы, считает
> бюджет и присылает **черновик в личку администратору** — отдельным сообщением на каждую команду
> с кнопкой «Опубликовать в чат». Бот публикует сбор в чат только после нажатия кнопки (поэтому он
> «владеет» сообщением и отметки оплат «+» продолжают работать).
>
> Чтобы получать черновики в личку, **каждый админ из `ADMIN_TG_IDS` должен один раз нажать Start**
> в диалоге с ботом.

---

## Реализованные функции

- [x] Чтение событий из двух Google-календарей + парсинг тегов
- [x] Еженедельные неанонимные опросы (Пт 12:00) с кросс-постингом тренировок
- [x] Сбор голосов опросов (кто придёт)
- [x] Помесячный расчёт бюджета (зал + тренер) с делением по правилам команд
- [x] Учёт персональных взносов за игры в бюджете
- [x] Парсер статистики матча без LLM + сопоставление игроков
- [x] Бюджет: черновик в личку администратору → публикация в чат по кнопке, отметки оплат «+», напоминания должникам
- [x] Google-таблица `Players` как источник правды: правка из бота/админки, импорт в БД (команда/кнопка/перед бюджетом), деактивация удалённых
- [x] Команды бота для игроков: `/player_add`, `/player_set`, `/player_del`, `/active`, `/sync_players`
- [x] Адаптивная админ-панель под паролем (игроки из таблицы, тарифы, бюджеты, оплаты)
- [x] Валидация окружения (zod), централизованная обработка ошибок
- [x] Миграции БД, Docker / docker-compose, healthcheck, graceful shutdown
- [x] Разовый CLI-импорт игроков из Google Sheet (первичный засев)

## Замечания / что стоит проверить

- **Парсер статистики** (`src/gamefee/parser.ts`) написан по селекторам из n8n (`.math-p-stat`). Структуру конкретного сайта чемпионата нужно сверить на реальной странице и при необходимости поправить селекторы / эвристику колонки минут.
- Сопоставление игроков из статистики с ростером идёт по фамилии — несопоставленные показываются в ответе `/game_fee`.
