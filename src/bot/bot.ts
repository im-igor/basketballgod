import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { registerCommands } from './commands/index.js';
import { registerPollAnswers } from './pollAnswers.js';
import { registerChatMemberNotifications } from './chatMember.js';

// Telegram по умолчанию не присылает chat_member. Явно запрашиваем все типы,
// которые обрабатывает приложение, чтобы не потерять команды, голоса и события чата.
export const BOT_ALLOWED_UPDATES = ['message', 'poll_answer', 'chat_member'] as const;

// apiRoot — HTTPS-релей к Bot API, если api.telegram.org заблокирован напрямую.
export const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
  client: env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : undefined,
});
if (env.TELEGRAM_API_ROOT) {
  log.info(`[bot] Bot API через релей: ${env.TELEGRAM_API_ROOT}`);
}

// Централизованная обработка ошибок: бот не должен падать из-за одной команды.
bot.catch((err) => {
  log.error('[bot] ошибка обработки апдейта', err.error);
});

registerPollAnswers(bot);
registerChatMemberNotifications(bot);
registerCommands(bot);

export async function setupBotCommandsMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'help', description: 'Справка по командам' },
    { command: 'active', description: 'Активность игрока: /active @login yes|no' },
  ]);
}
