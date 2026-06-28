import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { registerCommands } from './commands/index.js';
import { registerPollAnswers } from './pollAnswers.js';
import { registerBudgetPublish } from './budgetPublish.js';
import { registerBudgetAdjust } from './budgetAdjust.js';
import { registerPayMark } from './payMark.js';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// Централизованная обработка ошибок: бот не должен падать из-за одной команды.
bot.catch((err) => {
  log.error('[bot] ошибка обработки апдейта', err.error);
});

registerPollAnswers(bot);
registerBudgetPublish(bot);
registerPayMark(bot);
registerCommands(bot);
// После команд: текстовый обработчик ответов ловит только force-reply на наши запросы.
registerBudgetAdjust(bot);

export async function setupBotCommandsMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'help', description: 'Справка по командам' },
    { command: 'player_add', description: 'Добавить игрока: Имя | @login | RED|BLACK' },
    { command: 'player_set', description: 'Изменить игрока: @login поле=значение' },
    { command: 'player_del', description: 'Удалить игрока: /player_del @login' },
    { command: 'active', description: 'Активность игрока: /active @login yes|no' },
    { command: 'sync_players', description: 'Импорт таблицы игроков в БД' },
    { command: 'budget', description: 'Черновик бюджета: /budget RED|BLACK MM YYYY [url …]' },
    { command: 'debtors', description: 'Напомнить должникам: /debtors MM YYYY' },
    { command: 'pay', description: 'Отметить оплаты кнопками: /pay [MM YYYY]' },
    { command: 'poll', description: 'Разослать опросы на неделю (вручную)' },
  ]);
}
