import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { registerCommands } from './commands/index.js';
import { registerPollAnswers } from './pollAnswers.js';
import { registerPollDraft } from './pollDraft.js';
import { registerBudgetPublish } from './budgetPublish.js';
import { registerDebtorsPublish } from './debtorsPublish.js';
import { registerBudgetAdjust } from './budgetAdjust.js';
import { registerPayMark } from './payMark.js';

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
registerBudgetPublish(bot);
registerDebtorsPublish(bot);
registerPayMark(bot);
registerCommands(bot);
// После команд: текстовые обработчики ответов ловят только force-reply на наши запросы.
// pollDraft пропускает чужие сообщения через next() → budgetAdjust остаётся последним.
registerPollDraft(bot);
registerBudgetAdjust(bot);

export async function setupBotCommandsMenu(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'help', description: 'Справка по командам' },
    { command: 'active', description: 'Активность игрока: /active @login yes|no' },
    { command: 'sync_players', description: 'Импорт таблицы игроков в БД' },
    { command: 'sync_all', description: 'Импорт всех вкладок из таблицы в БД' },
    { command: 'budget', description: 'Черновик бюджета: /budget RED|BLACK MM YYYY [url …]' },
    { command: 'debtors', description: 'Черновик должников в личку: /debtors [RED|BLACK] [MM YYYY]' },
    { command: 'pay', description: 'Оплаты кнопками (✅ переключает): /pay [MM YYYY]' },
    { command: 'poll', description: 'Черновики опросов на неделю в личку (с правкой)' },
  ]);
}
