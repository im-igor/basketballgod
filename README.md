# 🏀 basketballgod

Telegram-бот + лёгкая админ-панель для двух любительских баскетбольных команд **Red** и **Black**: еженедельные опросы по тренировкам/играм из Google Calendar, ежемесячные бюджеты, взносы за игры и учёт оплат.

Переписан с нуля (TypeScript) с n8n-прототипа. Готов к запуску в контейнере (Docker / Yandex Cloud).

---

## Возможности

- **Опросы (Пт 12:00, Europe/Moscow).** Читает события из обоих Google-календарей на ближайшие 7 дней и шлёт неанонимные опросы в чаты команд (топик «Голосовалки и сборы»). Тренировки дублируются в чат другой команды (forward). Голоса собираются — видно поимённо, кто придёт.
  Ручной запуск `/poll` теперь шлёт **черновики в личку администратору** (по одному на событие): можно поправить текст вопроса и варианты ответов, переключить форвард тренировки, пропустить лишнее — и отправить каждый опрос в чат кнопкой. Так предотвращается отправка опроса с устаревшим временем тренировки. Авторассылка по пятницам осталась прямой.
- **Бюджеты (25-е число).** Считает помесячный сбор: аренда платного зала делится на всех активных, тренер за тренировки — по командам, плюс **персональные взносы за игры**. Берёт состав и тарифы из БД и присылает **черновик в личку администратору** (отдельно по каждой команде). Админ проверяет и кнопкой «Опубликовать в чат» отправляет сбор в чат команды.
- **Взносы за игры.** Регистрируются прямо в `/budget RED|BLACK MM YYYY url …`: парсит статистику матча с сайта чемпионата (без LLM), проверяет, что все сыгравшие — игроки указанной команды с `active=YES`/`employee=TRUE`, считает `тариф / число сыгравших` и добавляет в бюджет (соперник и сумма видны в сообщении).
- **Учёт оплат.** Отметка «+» напротив игрока (в боте или в панели) обновляет исходное сообщение сбора.
- **Напоминания должникам.**
- **Данные живут в Postgres.** Состав, тарифы, расписание и теги правятся в админке и хранятся в БД — это единственный источник правды (см. «Модель данных»).
- **Google-таблица — витрина.** Односторонняя выгрузка БД → таблица по кнопке (или `/sheet`), чтобы показать состав/тарифы человеку без доступа к админке. Обратно таблица не читается и на расчёты не влияет.
- **Админ-панель.** Адаптивная (мобайл/десктоп), под паролем: игроки, тарифы, крон, теги, бюджеты, оплаты, должники, ручной запуск опросов.

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
│  │  ├─ sheets.ts           # выгрузка БД → вкладки таблицы (только запись)
│  │  └─ tags.ts             # парсер тегов TYPE/GYM/COACH/INVOLVED/...
│  ├─ domain/                # чистая логика (бюджет, активность, взносы, сообщения, даты)
│  ├─ gamefee/parser.ts      # парсер статистики матча
│  ├─ services/              # оркестрация (poll, budget, gameFee, notify, sheetSync)
│  ├─ bot/                   # grammY: команды, allowlist, сбор голосов, публикация бюджета
│  ├─ scheduler/cron.ts      # Пт 12:00 (опросы), 25-е (черновик бюджета)
│  ├─ http/                  # Fastify: админ-панель + webhook + healthz
│  └─ util/                  # logger, args
├─ scripts/                  # copy-assets.mjs
├─ Dockerfile · docker-compose.yml · .env.example · README.md
```

---

## Модель данных (игроки)

**Источник правды по составу — Postgres, таблица `players`.** Правки идут через админку
(раздел «Игроки») и команду `/active`; Google-таблица на данные приложения не влияет.

```
Админка и /active  ──►  Postgres (источник правды)  ──►  расчёты: бюджет, должники, оплаты
                                  │
                                  └─ выгрузка по кнопке / /sheet ──►  Google-таблица (витрина, read-only для людей)
```

- Выгрузка односторонняя. Обратного чтения нет намеренно: устаревший лист иначе молча
  перезаписывал бы базу и деактивировал игроков перед расчётом сбора.
- Выгружаются 4 вкладки: `Players` (`№ | ФИО | tg_login | employee | team | active | active_from | active_to | notes`),
  `tariffs`, `cron`, `Tags`. Вкладка перезаписывается целиком, вместе со строкой заголовка.
- Форматы ячеек: `employee` → `TRUE/FALSE`, `active` → `YES/NO`, даты → `дд.мм.гггг`.
- Таблица **не обновляется автоматически** — перед тем как кому-то её показать, нажми
  «⬆ Всё в таблицу» в шапке админки или отправь боту `/sheet`.
- Бэкап делается на уровне БД (`pg_dump`), а не выгрузкой в лист.

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
2. **Расшарь оба календаря** на email сервис-аккаунта (`client_email` из ключа) с доступом «Просмотр». Если пользуешься выгрузкой-витриной — расшарь на него же таблицу с доступом **«Редактор»** (бот в неё пишет; без этих прав запись вернёт `403`), а людям её отдавай с доступом «Читатель». Таблица опциональна: без `GOOGLE_SHEET_ID` бот работает как обычно, недоступна будет только кнопка выгрузки.
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

Скопируй `.env.example` → `.env` и заполни. Ключевые: `TELEGRAM_BOT_TOKEN`, `*_CHAT_ID`/`*_THREAD_ID`, `ADMIN_TG_IDS`, `GOOGLE_CALENDAR_RED/BLACK`, ключ Google (`GOOGLE_SHEET_ID` — опционально, только для выгрузки-витрины), `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`. Расписание и тарифы имеют дефолты (см. файл).

---

## Запуск

### Вариант А: Docker Compose (рекомендуется)

```bash
cp .env.example .env          # заполни значения
mkdir -p secrets              # положи service-account.json, если ключ файлом
docker compose up -d --build  # поднимет postgres + приложение
docker compose logs -f app    # логи
```

Миграции прогоняются автоматически при старте. Состав игроков заводится в админ-панели (раздел «Игроки»).

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
Файл `service-account.json` — это JSON-ключ **сервисного аккаунта Google**, который ты создаёшь в [Google Cloud Console](https://console.cloud.google.com/) (подробно — в разделе [«2. Google (сервис-аккаунт)»](#2-google-сервис-аккаунт) выше). Кратко: создай service account, включи Calendar API + Sheets API, во вкладке **Keys** скачай ключ в формате JSON, и расшарь на его `client_email` календари (доступ «Просмотр») и — если нужна выгрузка-витрина — **таблицу с доступом «Редактор»** (бот в неё пишет).

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

### Шаг 7. Заведи состав
Открой админ-панель → «Игроки» и добавь игроков (это и есть источник правды).

### Шаг 8. Проверь работу
```bash
curl http://localhost:3000/healthz   # должен ответить ok
```
Админ-панель: `http://<публичный_IP_вм>:3000` (логин/пароль из `.env`).

> Чтобы панель открывалась снаружи — в **security group** виртуалки разреши входящий TCP на порт `3000` (или повесь nginx/Caddy с HTTPS и проксируй на `3000`). Для самого Telegram-бота открывать порты не нужно — он работает по long polling (исходящие соединения).

### Эксплуатация
```bash
docker compose logs -f app                 # логи
docker compose up -d --force-recreate app  # применить изменения .env (restart НЕ перечитывает env_file!)
docker compose restart app                 # просто перезапуск процесса (окружение НЕ обновляется)
docker compose up -d --build app           # пересборка после git pull / нового кода
docker compose down                        # остановить (данные БД сохранятся в volume pgdata)
```
Бэкап БД:
```bash
docker compose exec db pg_dump -U basketballgod basketballgod > backup_$(date +%F).sql
```

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

После выката новой версии:
1. если пользуешься выгрузкой в таблицу — у сервис-аккаунта должен быть доступ **«Редактор»** на неё (иначе запись вернёт `403`); людям её шарь с доступом **«Читатель»**;
2. убедись, что каждый админ из `ADMIN_TG_IDS` нажал **Start** в личке бота (для черновиков бюджета).

---

## Команды бота (только админы из `ADMIN_TG_IDS`)

| Команда | Действие |
|---|---|
| `/active @login yes\|no` | активность игрока на следующий месяц (пишет в БД) |
| `/sheet` | выгрузить данные из БД в Google-таблицу (Players, tariffs, cron, Tags) |
| `/budget RED\|BLACK MM YYYY [url [дд.мм.гггг]] …` | собрать бюджет команды → **черновик в личку**; ссылки на игры опциональны |
| `/debtors [MM YYYY]` | напомнить должникам (по умолчанию текущий месяц) |
| `/pay [MM YYYY]` | отметить оплаты кнопками: список должников **обеих** команд (имя «Имя Отчество Ф.»), нажатие = оплачено, есть отмена последнего |
| `/poll` | вручную разослать опросы на неделю |
| `/help` | справка |




## Замечания / что стоит проверить

- **Парсер статистики** (`src/gamefee/parser.ts`) сверен с вёрсткой businesschampions.ru (vesna-2026): блоки `.math-p-stat`/`.math-p-stat-2`, таблица `teams-page-2-table`, колонки «Игрок» и «ВР» (время на паркете) ищутся по тексту шапки с учётом `colspan`. Сыгравшим считается игрок с временем > 0. Соперник — название второго блока. Если сайт сменит вёрстку — поправь регулярки заголовков в парсере.
- Сопоставление игроков из статистики с ростером идёт по общему токену имени (терпимо к порядку «Имя Фамилия»/«Фамилия Имя»). Команду нужно указывать в `/budget` явно (RED/BLACK); если сыгравший не найден в ростере этой команды или не `active`/`employee` — `/budget` вернёт ошибку и не соберёт бюджет.
- **Дата матча** сайтом надёжно не отдаётся (грузится JS), поэтому в `/budget` её можно указать вручную после ссылки (`url дд.мм.гггг`) — только для наглядности в сообщении. От задвоения защищает структура: игра привязана к месяцу бюджета и уникальна по ссылке (`stat_url`).
