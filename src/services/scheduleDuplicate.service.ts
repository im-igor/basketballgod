import type { Api } from 'grammy';
import { env } from '../config/env.js';
import {
  deleteScheduledGameById,
  getScheduledGameById,
  listScheduleDuplicateGroups,
  markScheduleDuplicateNotified,
  recomputeScheduleConflicts,
} from '../db/repos/scheduledGames.repo.js';
import type { ScheduledGame } from '../db/types.js';
import type { ScheduleDuplicateGroup } from '../domain/schedule.js';
import { deleteCalendarEvent } from '../google/calendar.js';
import { log } from '../util/logger.js';
import { syncScheduledGame } from './scheduleImport.service.js';

export interface DuplicateNotificationResult {
  groupsNotified: number;
  messagesSent: number;
  errors: string[];
}

export interface DeleteScheduledGameResult {
  deleted: ScheduledGame;
  syncWarnings: string[];
}

export interface ScheduleDuplicateCleanupDeps {
  deleteCalendar: typeof deleteCalendarEvent;
  syncGame: typeof syncScheduledGame;
}

const defaultCleanupDeps: ScheduleDuplicateCleanupDeps = {
  deleteCalendar: deleteCalendarEvent,
  syncGame: syncScheduledGame,
};

function html(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gameDate(game: ScheduledGame): string {
  return game.game_date instanceof Date
    ? game.game_date.toISOString().slice(0, 10)
    : String(game.game_date).slice(0, 10);
}

function duplicateMessage(group: ScheduleDuplicateGroup): string {
  const first = group.games[0]!;
  const time = first.game_time ? String(first.game_time).slice(0, 5) : 'время не указано';
  const variants = group.games.map((game, index) => {
    const sourceState = game.present_in_source ? '✅ есть в источнике' : '⚠️ больше нет в источнике';
    return [
      `<b>${index + 1}.</b> ID <code>${html(game.external_id)}</code> · ${sourceState}`,
      `Площадка: ${html(game.location ?? 'не указана')}`,
      `Calendar: ${game.calendar_event_id ? 'есть' : 'нет'} · опрос: ${game.poll_sent_at ? 'отправлен' : 'не отправлен'}`,
    ].join('\n');
  }).join('\n\n');
  return [
    '⚠️ <b>В расписании найден возможный дубль</b>',
    '',
    `${html(group.source)} · ${html(first.team)}`,
    `<b>${html(first.team_a)} — ${html(first.team_b)}</b>`,
    `${html(gameDate(first))} · ${html(time)}`,
    '',
    variants,
    '',
    'Проверь записи в разделе «Расписание» и удали лишнюю вручную.',
  ].join('\n');
}

/** Уведомить администраторов только о новых/изменившихся группах дублей. */
export async function notifyScheduleDuplicatesToAdmins(
  api: Api,
  groups: ScheduleDuplicateGroup[],
): Promise<DuplicateNotificationResult> {
  const result: DuplicateNotificationResult = { groupsNotified: 0, messagesSent: 0, errors: [] };
  for (const group of groups) {
    if (group.games.every((game) => game.duplicate_notified_at !== null)) continue;
    let delivered = false;
    for (const adminId of env.ADMIN_TG_IDS) {
      try {
        await api.sendMessage(adminId, duplicateMessage(group), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        delivered = true;
        result.messagesSent++;
      } catch (err) {
        const message = (err as Error).message;
        result.errors.push(`администратор ${adminId}: ${message}`);
        log.warn(`[schedule] не удалось уведомить администратора ${adminId} о дубле`, message);
      }
    }
    if (!delivered) continue;
    await markScheduleDuplicateNotified(group.games.map((game) => game.id));
    result.groupsNotified++;
  }
  return result;
}

/**
 * Удалить выбранную строку и принадлежащее ей событие Google Calendar.
 * Telegram-опрос администратор удаляет вручную, поэтому здесь его не меняем.
 * В БД запись удаляется последней, поэтому временную внешнюю ошибку можно безопасно повторить.
 */
export async function deleteScheduledGameWithArtifacts(
  id: string,
  deps: ScheduleDuplicateCleanupDeps = defaultCleanupDeps,
): Promise<DeleteScheduledGameResult> {
  const game = await getScheduledGameById(id);
  if (!game) throw new Error('Матч расписания не найден');

  const duplicateGroups = await listScheduleDuplicateGroups(game.source, game.team);
  const group = duplicateGroups.find((candidate) => candidate.games.some((item) => item.id === game.id));
  if (!group) throw new Error('Удаление доступно только для матча, отмеченного как возможный дубль');

  if (game.calendar_event_id) {
    await deps.deleteCalendar(game.team, game.calendar_event_id);
  }

  const deleted = await deleteScheduledGameById(game.id);
  if (!deleted) throw new Error('Матч расписания уже удалён');

  const rowsToSync = new Map<string, ScheduledGame>();
  for (const sibling of group.games) {
    if (sibling.id === game.id) continue;
    const fresh = await getScheduledGameById(sibling.id);
    if (fresh) rowsToSync.set(fresh.id, fresh);
  }
  for (const changed of await recomputeScheduleConflicts()) rowsToSync.set(changed.id, changed);

  // Если в группе было больше двух строк, оставшиеся всё ещё требуют решения администратора.
  const remainingDuplicates = await listScheduleDuplicateGroups();
  const duplicateIds = new Set(remainingDuplicates.flatMap((candidate) => candidate.games.map((item) => item.id)));
  const syncWarnings: string[] = [];
  for (const row of rowsToSync.values()) {
    if (duplicateIds.has(row.id)) continue;
    try {
      await deps.syncGame(row);
    } catch (err) {
      syncWarnings.push(`${row.team_a} — ${row.team_b}: ${(err as Error).message}`);
    }
  }
  return { deleted, syncWarnings };
}
