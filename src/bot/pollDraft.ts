import { InlineKeyboard, type Api, type Bot } from 'grammy';
import { env } from '../config/env.js';
import { isAdmin } from './middlewares/auth.js';
import { buildPollDraftMessage } from '../domain/messages.js';
import { publishPollDraft } from '../services/poll.service.js';
import {
  getPollDraft,
  setPollDraftForward,
  setPollDraftStatus,
  updatePollDraftOptions,
  updatePollDraftText,
  type PollDraftRow,
} from '../db/repos/pollDrafts.repo.js';
import { log } from '../util/logger.js';

const QUESTION_MAX = 300; // лимит вопроса опроса Telegram
const OPTION_MAX = 100; // лимит варианта ответа Telegram
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;

/** Клавиатура под черновиком опроса: правки + публикация. */
function pollDraftKeyboard(d: PollDraftRow): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✏️ Текст', `polltext:${d.id}`)
    .text('✏️ Варианты', `pollopts:${d.id}`)
    .row();
  if (d.is_training) {
    kb.text(`🔁 Форвард: ${d.forward ? 'вкл' : 'выкл'}`, `pollfwd:${d.id}`);
  }
  kb.text('🗑 Пропустить', `pollskip:${d.id}`).row();
  kb.text(`✅ Отправить в чат ${d.team}`, `pollsend:${d.id}`);
  return kb;
}

/** Отправить черновики опросов администраторам в личку (по одному сообщению на опрос). */
export async function sendPollDraftsToAdmins(api: Api, drafts: PollDraftRow[]): Promise<void> {
  const info =
    drafts.length === 0
      ? '🗳 На ближайшую неделю событий в календарях не нашлось — опросов нет.'
      : `🗳 <b>Черновики опросов на неделю (${drafts.length})</b>\n` +
        `Проверь, при необходимости поправь и отправь каждый в чат кнопкой.`;

  for (const adminId of env.ADMIN_TG_IDS) {
    const warn = (err: unknown) =>
      log.warn(
        `[poll-draft] не удалось отправить черновик админу ${adminId} (нажал ли он Start у бота?)`,
        (err as Error).message,
      );
    await api
      .sendMessage(adminId, info, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      .catch(warn);
    for (const d of drafts) {
      await api
        .sendMessage(adminId, buildPollDraftMessage(d), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: pollDraftKeyboard(d),
        })
        .catch(warn);
    }
  }
}

interface Pending {
  kind: 'text' | 'options';
  draftId: number;
  chatId: number; // чат и id исходного черновика — чтобы перерисовать его после ответа
  msgId: number;
}

// Ожидание текстового ответа от админа (по user_id). В памяти: теряется при рестарте — не страшно.
const pending = new Map<number, Pending>();

/** Перерисовать сообщение-черновик по текущему состоянию из БД. */
async function redraw(
  api: Api,
  draftId: number,
  chatId: number,
  msgId: number,
  withKeyboard = true,
): Promise<void> {
  const d = await getPollDraft(draftId);
  if (!d) return;
  await api
    .editMessageText(chatId, msgId, buildPollDraftMessage(d), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: withKeyboard && d.status === 'pending' ? pollDraftKeyboard(d) : undefined,
    })
    .catch((err) => log.warn('[poll-draft] не удалось перерисовать черновик', (err as Error).message));
}

export function registerPollDraft(bot: Bot): void {
  // Отправить опрос в чат команды
  bot.callbackQuery(/^pollsend:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const { team, forwarded } = await publishPollDraft(ctx.api, id);
      await ctx.answerCallbackQuery({ text: '✅ Отправлено в чат' });
      await redraw(ctx.api, id, ctx.callbackQuery.message!.chat.id, ctx.callbackQuery.message!.message_id);
      await ctx.reply(`✅ Опрос отправлен в чат ${team}${forwarded ? ' (+ форвард в чат другой команды)' : ''}.`);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });

  // Пропустить опрос (не отправлять)
  bot.callbackQuery(/^pollskip:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    const draft = await getPollDraft(id);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: 'Черновик не найден', show_alert: true });
      return;
    }
    if (draft.status === 'sent') {
      await ctx.answerCallbackQuery({ text: 'Опрос уже отправлен', show_alert: true });
      return;
    }
    await setPollDraftStatus(id, 'skipped');
    await ctx.answerCallbackQuery({ text: '🗑 Пропущен' });
    await redraw(ctx.api, id, ctx.callbackQuery.message!.chat.id, ctx.callbackQuery.message!.message_id);
  });

  // Переключить форвард тренировки
  bot.callbackQuery(/^pollfwd:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    const draft = await getPollDraft(id);
    if (!draft || draft.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: 'Черновик недоступен', show_alert: true });
      return;
    }
    await setPollDraftForward(id, !draft.forward);
    await ctx.answerCallbackQuery({ text: `Форвард: ${!draft.forward ? 'вкл' : 'выкл'}` });
    await redraw(ctx.api, id, ctx.callbackQuery.message!.chat.id, ctx.callbackQuery.message!.message_id);
  });

  // Запрос нового текста вопроса
  bot.callbackQuery(/^polltext:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    const msg = ctx.callbackQuery.message;
    if (!msg) {
      await ctx.answerCallbackQuery({ text: 'Сообщение недоступно', show_alert: true });
      return;
    }
    pending.set(ctx.from!.id, { kind: 'text', draftId: id, chatId: msg.chat.id, msgId: msg.message_id });
    await ctx.answerCallbackQuery();
    await ctx.reply('✏️ Ответьте новым текстом вопроса опроса (до 300 символов).', {
      reply_markup: { force_reply: true },
    });
  });

  // Запрос новых вариантов ответов
  bot.callbackQuery(/^pollopts:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    const msg = ctx.callbackQuery.message;
    if (!msg) {
      await ctx.answerCallbackQuery({ text: 'Сообщение недоступно', show_alert: true });
      return;
    }
    pending.set(ctx.from!.id, { kind: 'options', draftId: id, chatId: msg.chat.id, msgId: msg.message_id });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✏️ Ответьте вариантами ответов через запятую (от 2 до 10).\nПример: Да, Нет, Для Родиона',
      { reply_markup: { force_reply: true } },
    );
  });

  // Текстовые ответы на запросы (текст / варианты) — только в личке.
  // Если запись не наша — передаём дальше (next), чтобы не перехватывать чужие ответы.
  bot.on('message:text', async (ctx, next) => {
    const uid = ctx.from?.id;
    if (ctx.chat?.type !== 'private' || uid === undefined || !pending.has(uid)) {
      await next();
      return;
    }
    const entry = pending.get(uid)!;
    pending.delete(uid);
    if (!isAdmin(uid)) return;

    const draft = await getPollDraft(entry.draftId);
    if (!draft) {
      await ctx.reply('Черновик не найден (возможно, пересобран).');
      return;
    }
    if (draft.status !== 'pending') {
      await ctx.reply('Этот опрос уже отправлен или пропущен — правка не применена.');
      return;
    }

    try {
      if (entry.kind === 'text') {
        const text = ctx.message.text.trim().slice(0, QUESTION_MAX);
        if (!text) {
          await ctx.reply('Пустой текст — не применил.');
          return;
        }
        await updatePollDraftText(entry.draftId, text);
        await redraw(ctx.api, entry.draftId, entry.chatId, entry.msgId);
        await ctx.reply('✅ Текст вопроса обновлён.');
        return;
      }

      // options
      const options = ctx.message.text
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) {
        await ctx.reply(`Нужно от ${OPTIONS_MIN} до ${OPTIONS_MAX} вариантов через запятую.`);
        return;
      }
      const tooLong = options.find((o) => o.length > OPTION_MAX);
      if (tooLong) {
        await ctx.reply(`Вариант «${tooLong}» длиннее ${OPTION_MAX} символов.`);
        return;
      }
      await updatePollDraftOptions(entry.draftId, options);
      await redraw(ctx.api, entry.draftId, entry.chatId, entry.msgId);
      await ctx.reply('✅ Варианты ответов обновлены.');
    } catch (err) {
      log.error('[poll-draft] ошибка обработки ответа', (err as Error).message);
      await ctx.reply(`⚠️ Ошибка: ${(err as Error).message}`);
    }
  });
}
