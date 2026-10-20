import type { Api, Bot } from 'grammy';
import { isAdmin } from './middlewares/auth.js';
import { recalcBudget, type RecalcResult } from '../services/budget.service.js';
import { registerFriendly } from '../services/gameFee.service.js';
import { draftKeyboard, refreshBudgetMessage, renderBudgetFromDb } from '../services/notify.service.js';
import { getBudget, getBudgetById } from '../db/repos/budgets.repo.js';
import { deleteLastManualFriendly } from '../db/repos/games.repo.js';
import { log } from '../util/logger.js';
import { usesSharedCoach } from '../domain/budget.js';

/**
 * Корректировки черновика бюджета кнопками в личке: ± оплат тренера, комментарий,
 * добавление/удаление внепланового товарищеского. Перерасчёт — recalcBudget (без календаря),
 * затем перерисовка сообщения-черновика.
 */

interface Pending {
  kind: 'note' | 'friendly';
  budgetId: number;
  chatId: number; // чат и id исходного драфта — чтобы отредактировать его после ответа
  msgId: number;
}

// Ожидание текстового ответа от админа (по user_id). В памяти: теряется при рестарте — не страшно.
const pending = new Map<number, Pending>();
/** Опубликованные суммы сохраняются; правки идут в следующий черновик. */
async function confirmedLateEdit(_userId: number, budgetId: number, _action: string, bothTeams = false): Promise<boolean> {
  const budget = await getBudgetById(budgetId);
  if (!budget) return true;
  const other = bothTeams
    ? await getBudget(budget.team === 'RED' ? 'BLACK' : 'RED', budget.month, budget.year)
    : null;
  return budget.message_id == null && other?.message_id == null;
}

async function redrawDraft(api: Api, p: Pending, r: RecalcResult): Promise<void> {
  // Сохраняем в черновике отметки проверки, сделанной при сборке бюджета.
  const rendered = await renderBudgetFromDb(r.budgetId, { savedChatStatus: true });
  await api
    .editMessageText(p.chatId, p.msgId, rendered?.text ?? r.message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: draftKeyboard(r.budgetId, r.team, rendered?.messageId != null),
    })
    .catch((err) => log.warn('[budget-adjust] не удалось перерисовать драфт', (err as Error).message));
  if (rendered?.messageId != null) await refreshBudgetMessage(api, r.budgetId);
}

export function registerBudgetAdjust(bot: Bot): void {
  // ± оплат тренера
  bot.callbackQuery(/^budcoach:(\d+):(-1|1)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const [, idRaw, changeRaw] = ctx.callbackQuery.data.split(':');
    const id = Number(idRaw);
    try {
      const budget = await getBudgetById(id);
      const shared = budget ? usesSharedCoach(budget.month, budget.year) : false;
      if (!(await confirmedLateEdit(ctx.from!.id, id, `coach:${changeRaw}`, shared))) {
        await ctx.answerCallbackQuery({ text: 'Сбор опубликован; суммы зафиксированы. Используй корректировки следующего бюджета.', show_alert: true });
        return;
      }
      const r = await recalcBudget(id, { coachDeltaChange: Number(changeRaw) });
      if (!r) {
        await ctx.answerCallbackQuery({ text: 'Бюджет не найден', show_alert: true });
        return;
      }
      const otherRefreshed = budget && usesSharedCoach(budget.month, budget.year)
        ? await refreshOtherTeam(ctx.api, budget.team, budget.month, budget.year) : true;
      const rendered = await renderBudgetFromDb(r.budgetId, { savedChatStatus: true });
      await ctx
        .editMessageText(rendered?.text ?? r.message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: draftKeyboard(r.budgetId, r.team, rendered?.messageId != null),
        })
        .catch(() => undefined);
      const refreshed = rendered?.messageId != null ? await refreshBudgetMessage(ctx.api, r.budgetId) : true;
      await ctx.answerCallbackQuery({ text: refreshed && otherRefreshed
        ? `Оплат тренера ${r.team}: ${r.effCoach}; суммы пересчитаны`
        : 'Поправка сохранена, но не все сборы в чатах обновились', show_alert: !refreshed || !otherRefreshed });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });

  // Запрос комментария к строке тренера
  bot.callbackQuery(/^budnote:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    const budget = await getBudgetById(id);
    if (!(await confirmedLateEdit(ctx.from!.id, id, 'note',
      budget ? usesSharedCoach(budget.month, budget.year) : false))) {
      await ctx.answerCallbackQuery({ text: 'Сбор опубликован; суммы зафиксированы.', show_alert: true });
      return;
    }
    const msg = ctx.callbackQuery.message;
    if (!msg) {
      await ctx.answerCallbackQuery({ text: 'Сообщение недоступно', show_alert: true });
      return;
    }
    pending.set(ctx.from!.id, { kind: 'note', budgetId: id, chatId: msg.chat.id, msgId: msg.message_id });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✏️ Ответьте текстом комментария к строке тренера\n(например: «Одну оплату тренера перенёс с 11 мая»).',
      { reply_markup: { force_reply: true } },
    );
  });

  // Запрос данных товарищеского
  bot.callbackQuery(/^budfriendly:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    if (!(await confirmedLateEdit(ctx.from!.id, id, 'friendly', true))) {
      await ctx.answerCallbackQuery({ text: 'Сбор опубликован; суммы зафиксированы.', show_alert: true });
      return;
    }
    const msg = ctx.callbackQuery.message;
    if (!msg) {
      await ctx.answerCallbackQuery({ text: 'Сообщение недоступно', show_alert: true });
      return;
    }
    pending.set(ctx.from!.id, { kind: 'friendly', budgetId: id, chatId: msg.chat.id, msgId: msg.message_id });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '🤝 Ответьте: Соперник | судья / тренер / оба и @login сыгравших (можно из обеих команд).\n' +
        'Пример: Гипротрубопровод | судья @ivan @petr @maria',
      { reply_markup: { force_reply: true } },
    );
  });

  // Удалить последний ручной товарищеский
  bot.callbackQuery(/^budfrdel:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }
    const id = Number(ctx.callbackQuery.data.split(':')[1]);
    try {
      const budget = await getBudgetById(id);
      if (!budget) {
        await ctx.answerCallbackQuery({ text: 'Бюджет не найден', show_alert: true });
        return;
      }
      if (!(await confirmedLateEdit(ctx.from!.id, id, 'friendly-delete', true))) {
        await ctx.answerCallbackQuery({ text: 'Сбор уже опубликован. Суммы в чатах изменятся; сверь полученные переводы. Нажми кнопку ещё раз для подтверждения.', show_alert: true });
        return;
      }
      const removed = await deleteLastManualFriendly(budget.month, budget.year);
      const r = await recalcBudget(id);
      if (r) {
        const rendered = await renderBudgetFromDb(r.budgetId, { savedChatStatus: true });
        await ctx
          .editMessageText(rendered?.text ?? r.message, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: draftKeyboard(r.budgetId, r.team, rendered?.messageId != null),
          })
          .catch(() => undefined);
        if (rendered?.messageId != null) await refreshBudgetMessage(ctx.api, r.budgetId);
        // Товарищеский MIXED влияет и на другую команду — обновим её данные/сообщение.
        await refreshOtherTeam(ctx.api, budget.team, budget.month, budget.year);
      }
      await ctx.answerCallbackQuery({
        text: removed ? 'Последний товарищеский удалён' : 'Ручных товарищеских нет',
      });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `Ошибка: ${(err as Error).message}`, show_alert: true });
    }
  });

  // Текстовые ответы на запросы (комментарий / товарищеский) — только в личке.
  bot.on('message:text', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const uid = ctx.from?.id;
    if (uid === undefined) return;
    const entry = pending.get(uid);
    if (!entry) return; // не наш диалог — пропускаем
    pending.delete(uid);
    if (!isAdmin(uid)) return;

    const text = ctx.message.text.trim();
    const budget = await getBudgetById(entry.budgetId);
    if (!budget) {
      await ctx.reply('Бюджет не найден (возможно, пересобран).');
      return;
    }

    try {
      if (entry.kind === 'note') {
        const r = await recalcBudget(entry.budgetId, { coachNote: text });
        const otherRefreshed = usesSharedCoach(budget.month, budget.year)
          ? await refreshOtherTeam(ctx.api, budget.team, budget.month, budget.year) : true;
        if (r) await redrawDraft(ctx.api, entry, r);
        await ctx.reply(otherRefreshed
          ? '✅ Комментарий к строке тренера обновлён.'
          : '⚠️ Комментарий сохранён, но сообщение другой команды в чате не обновилось.');
        return;
      }


      // friendly: всё до первого «|» — соперник; после — взносы и @login.
      const pipe = text.indexOf('|');
      const opponentName = pipe >= 0 ? text.slice(0, pipe).trim() : '';
      const rest = pipe >= 0 ? text.slice(pipe + 1).trim() : text;
      const lower = rest.toLowerCase();
      const coach = /тренер|оба/.test(lower);
      const judge = /судья|оба/.test(lower);
      if (!coach && !judge) {
        await ctx.reply('Укажи «судья», «тренер» или «оба». Пример: Соперник | судья @ivan @petr');
        return;
      }
      const logins = rest
        .split(/\s+/)
        .filter((t) => /^@?[A-Za-z0-9_]{3,}$/.test(t) && !/^(судья|тренер|оба)$/i.test(t));
      if (logins.length === 0) {
        await ctx.reply('Не нашёл ни одного @login сыгравших.');
        return;
      }
      const label = opponentName ? `Товарищеская игра с «${opponentName}»` : 'Товарищеская игра';
      const { matched, unmatched, fee } = await registerFriendly(
        logins,
        { coach, judge, label },
        budget.month,
        budget.year,
      );
      if (matched === 0) {
        await ctx.reply(`Никого не сматчил с ростером: ${unmatched.join(', ')}`);
        return;
      }
      const r = await recalcBudget(entry.budgetId);
      if (r) await redrawDraft(ctx.api, entry, r);
      await refreshOtherTeam(ctx.api, budget.team, budget.month, budget.year);
      const warn = unmatched.length ? `\n⚠️ не сопоставлены: ${unmatched.join(', ')}` : '';
      await ctx.reply(`✅ ${label}: ${matched} чел., ${fee}₽ с каждого.${warn}`);
    } catch (err) {
      log.error('[budget-adjust] ошибка обработки ответа', (err as Error).message);
      await ctx.reply(`⚠️ Ошибка: ${(err as Error).message}`);
    }
  });
}

/** Пересчитать и обновить опубликованное сообщение другой команды (товарищеский — MIXED). */
async function refreshOtherTeam(
  api: Api,
  team: 'RED' | 'BLACK',
  month: number,
  year: number,
): Promise<boolean> {
  const other = team === 'RED' ? 'BLACK' : 'RED';
  const otherBudget = await getBudget(other, month, year);
  if (!otherBudget) return true;
  await recalcBudget(otherBudget.id);
  return otherBudget.message_id == null || await refreshBudgetMessage(api, otherBudget.id).catch(() => false);
}
