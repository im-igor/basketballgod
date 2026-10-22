// Узкие импорты: общий googleapis загружает типы всех Google API при сборке.
import { auth, calendar } from 'googleapis/build/src/apis/calendar/index.js';
import { sheets } from 'googleapis/build/src/apis/sheets/index.js';
import { env } from '../config/env.js';

/**
 * Авторизация через сервисный аккаунт Google.
 * Ключ берём из base64 (GOOGLE_SERVICE_ACCOUNT_BASE64) либо из файла
 * (GOOGLE_APPLICATION_CREDENTIALS). Календари и таблицу нужно расшарить
 * на email сервис-аккаунта (client_email из ключа).
 */

const SCOPES = [
  // Импорт расписания создаёт и обновляет матчи в календарях команд.
  'https://www.googleapis.com/auth/calendar',
  // В таблицу только пишем (выгрузка из БД), но узкого write-only scope у Sheets нет.
  'https://www.googleapis.com/auth/spreadsheets',
];

function loadCredentials(): { client_email: string; private_key: string } | undefined {
  if (env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as { client_email: string; private_key: string };
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  }
  return undefined;
}

let authClient: ReturnType<typeof buildAuth> | null = null;

function buildAuth() {
  const creds = loadCredentials();
  if (creds) {
    return new auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
  }
  // Иначе googleapis сам прочитает файл из GOOGLE_APPLICATION_CREDENTIALS.
  return new auth.GoogleAuth({ scopes: SCOPES });
}

export function getAuth() {
  if (!authClient) authClient = buildAuth();
  return authClient;
}

export function calendarClient() {
  return calendar({ version: 'v3', auth: getAuth() });
}

export function sheetsClient() {
  return sheets({ version: 'v4', auth: getAuth() });
}
