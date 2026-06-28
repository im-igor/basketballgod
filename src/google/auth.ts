import { google } from 'googleapis';
import { env } from '../config/env.js';

/**
 * Авторизация через сервисный аккаунт Google.
 * Ключ берём из base64 (GOOGLE_SERVICE_ACCOUNT_BASE64) либо из файла
 * (GOOGLE_APPLICATION_CREDENTIALS). Календари и таблицу нужно расшарить
 * на email сервис-аккаунта (client_email из ключа).
 */

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  // Таблица — источник правды по игрокам: нужен доступ на запись (read/write).
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
    return new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
  }
  // Иначе googleapis сам прочитает файл из GOOGLE_APPLICATION_CREDENTIALS.
  return new google.auth.GoogleAuth({ scopes: SCOPES });
}

export function getAuth() {
  if (!authClient) authClient = buildAuth();
  return authClient;
}

export function calendarClient() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

export function sheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}
