import type { Bot } from 'grammy';
import { pollSessionExists, upsertVote } from '../db/repos/polls.repo.js';
import { linkTelegramUser } from '../db/repos/players.repo.js';
import { log } from '../util/logger.js';

/**
 * Сбор голосов из неанонимных опросов. Telegram присылает poll_answer с
 * poll_id, пользователем и выбранными вариантами. Сохраняем — так тренер
 * понимает поимённо, кто придёт.
 */
export function registerPollAnswers(bot: Bot): void {
  bot.on('poll_answer', async (ctx) => {
    const pa = ctx.pollAnswer;
    try {
      // Реагируем только на опросы, которые отправили мы.
      if (!(await pollSessionExists(pa.poll_id))) return;

      const user = pa.user;
      const fullName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(' ')
        : null;
      const username = user?.username ? `@${user.username}` : null;

      await upsertVote({
        poll_id: pa.poll_id,
        tg_user_id: user?.id ?? 0,
        tg_username: username,
        full_name: fullName,
        option_ids: [...pa.option_ids],
      });

      // Заодно привязываем telegram user_id к игроку по @username.
      if (username && user?.id) {
        await linkTelegramUser(username, user.id).catch(() => undefined);
      }
    } catch (err) {
      log.error('[poll_answer] не удалось сохранить голос', (err as Error).message);
    }
  });
}
