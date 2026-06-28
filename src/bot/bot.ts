import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { registerCommands } from './commands/index.js';
import { registerPollAnswers } from './pollAnswers.js';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// Централизованная обработка ошибок: бот не должен падать из-за одной команды.
bot.catch((err) => {
  log.error('[bot] ошибка обработки апдейта', err.error);
});

registerPollAnswers(bot);
registerCommands(bot);

export async function setupBotCommandsMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'help', description: 'Справка по командам' },
    { command: 'active', description: 'Активность игрока: /active @login yes|no' },
    { command: 'budget', description: 'Собрать бюджет: /budget MM YYYY' },
    { command: 'game_fee', description: 'Взнос за игру: /game_fee url ...' },
    { command: 'debtors', description: 'Напомнить должникам: /debtors MM YYYY' },
    { command: 'pay', description: 'Отметить оплату: /pay @login MM YYYY' },
    { command: 'poll', description: 'Разослать опросы на неделю (вручную)' },
  ]);
}
