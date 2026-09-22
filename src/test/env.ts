// Только фиктивная конфигурация. Тесты не читают .env и не обращаются к внешним сервисам.
Object.assign(process.env, {
  NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: '123456:local-test-token-not-a-real-secret',
  TELEGRAM_USE_WEBHOOK: 'false', BLACK_CHAT_ID: '-1', RED_CHAT_ID: '-2',
  GOOGLE_CALENDAR_RED: 'test-red', GOOGLE_CALENDAR_BLACK: 'test-black',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/test-credentials.json',
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  ADMIN_USERNAME: 'test', ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 'test-session-secret',
});
