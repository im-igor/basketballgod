import { z } from 'zod';

/**
 * Валидация переменных окружения. Падаем на старте с понятной ошибкой,
 * если конфигурация неполна — чтобы не ловить странности в рантайме.
 */

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csvNumbers = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s)),
  )
  .pipe(z.array(z.number().int()));

const csvStrings = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(2, 'Нужно минимум 2 варианта ответа'));

const schema = z.object({
  NODE_ENV: z.string().default('production'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(20, 'Укажи TELEGRAM_BOT_TOKEN'),
  TELEGRAM_USE_WEBHOOK: boolish.default('false'),
  WEBHOOK_DOMAIN: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  // Если api.telegram.org недоступен напрямую (блокировка egress в RU-облаке) —
  // адрес HTTPS-релея к Bot API (напр. https://proxy.basketballgod.ru:9443).
  // Пусто = ходим напрямую в Telegram.
  TELEGRAM_API_ROOT: z.string().url().optional(),

  BLACK_CHAT_ID: z.coerce.number().int(),
  BLACK_THREAD_ID: z.coerce.number().int().optional(),
  RED_CHAT_ID: z.coerce.number().int(),
  RED_THREAD_ID: z.coerce.number().int().optional(),
  // По умолчанию общий топик живёт в BLACK. Для тестового bball_test его
  // подменяют COLLECTION_CHAT_ID / COLLECTION_THREAD_ID без правки кода.
  COLLECTION_CHAT_ID: z.coerce.number().int().optional(),
  COLLECTION_THREAD_ID: z.coerce.number().int().optional(),
  // Позволяет прогнать новую маршрутизацию на bball_test до декабря.
  COMMON_CHAT_ENABLED: boolish.default('false'),

  ADMIN_TG_IDS: csvNumbers.default('524515690'),
  POLL_OPTIONS: csvStrings.default('Да,Нет,Для Родиона'),
  // Фолбэк-горизонты опросов (дней вперёд), если поле в cron_config пустое.
  POLL_TRAINING_HORIZON_DAYS: z.coerce.number().int().positive().default(7),
  POLL_GAME_HORIZON_DAYS: z.coerce.number().int().positive().default(7),

  // Schedule
  TZ: z.string().default('Europe/Moscow'),
  // Раздельные расписания опросов (фолбэк для cron_config): тренировки и игры.
  POLL_TRAINING_CRON: z.string().default('0 12 * * 5'),
  POLL_GAME_CRON: z.string().default('0 12 * * 5'),

  // Google
  GOOGLE_CALENDAR_RED: z.string().min(1),
  GOOGLE_CALENDAR_BLACK: z.string().min(1),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_BASE64: z.string().optional(),
  GOOGLE_SHEET_ID: z.string().optional(),

  // DB
  DATABASE_URL: z.string().min(1, 'Укажи DATABASE_URL'),

  // Admin panel
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(4, 'ADMIN_PASSWORD слишком короткий'),
  SESSION_SECRET: z.string().min(8, 'SESSION_SECRET слишком короткий'),
  // Хостовый каталог, смонтированный в /backups внутри контейнера.
  BACKUP_HOST_ROOT: z.string().optional(),
  BACKUP_MOUNT_ROOT: z.string().optional(),
  BACKUP_ENV_FILE: z.string().optional(),
  BACKUP_SECRETS_DIR: z.string().optional(),

  COACH_PER_GAME: z.coerce.number().positive().default(5000),

  // Реквизиты для сбора (показываются в сообщении)
  PAYMENT_SBER_URL: z.string().default('https://messenger.online.sberbank.ru/sl/e32SAQ4LqXKTuGScL'),
  PAYMENT_TBANK_URL: z.string().default('https://www.tbank.ru/cf/4293unKi0tl'),

  // Наша команда на сайте чемпионата (для game_fee): по этому слову в названии
  // команды определяем «своих» игроков.
  OUR_TEAM_KEYWORD: z.string().default('Yandex'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n❌ Неверная конфигурация окружения:\n${issues}\n`);
  process.exit(1);
}

const e = parsed.data;

// Доп. согласованность: webhook требует домен и секрет.
if (e.TELEGRAM_USE_WEBHOOK && (!e.WEBHOOK_DOMAIN || !e.WEBHOOK_SECRET)) {
  // eslint-disable-next-line no-console
  console.error('❌ TELEGRAM_USE_WEBHOOK=true требует WEBHOOK_DOMAIN и WEBHOOK_SECRET');
  process.exit(1);
}
if (!e.GOOGLE_APPLICATION_CREDENTIALS && !e.GOOGLE_SERVICE_ACCOUNT_BASE64) {
  // eslint-disable-next-line no-console
  console.error(
    '❌ Нужен Google сервис-аккаунт: задай GOOGLE_APPLICATION_CREDENTIALS или GOOGLE_SERVICE_ACCOUNT_BASE64',
  );
  process.exit(1);
}

export type Team = 'RED' | 'BLACK';

export const env = {
  ...e,
  isProd: e.NODE_ENV === 'production',
  chats: {
    RED: { chatId: e.RED_CHAT_ID, threadId: e.RED_THREAD_ID },
    BLACK: { chatId: e.BLACK_CHAT_ID, threadId: e.BLACK_THREAD_ID },
  } as Record<Team, { chatId: number; threadId?: number }>,
  calendars: {
    RED: e.GOOGLE_CALENDAR_RED,
    BLACK: e.GOOGLE_CALENDAR_BLACK,
  } as Record<Team, string>,
  // Общий чат и топик с декабря-2026 строятся на существующем BLACK-чате.
  collectionChat: {
    chatId: e.COLLECTION_CHAT_ID ?? e.BLACK_CHAT_ID,
    threadId: e.COLLECTION_THREAD_ID ?? e.BLACK_THREAD_ID,
  },
};

export const TEAMS: Team[] = ['RED', 'BLACK'];
