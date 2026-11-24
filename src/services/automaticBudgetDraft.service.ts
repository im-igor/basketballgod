import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import { getBudget } from '../db/repos/budgets.repo.js';
import {
  claimAutomaticDraft,
  markAutomaticDraftFailed,
  markAutomaticDraftSent,
} from '../db/repos/budgetAutoDrafts.repo.js';
import { usesCommonBudget } from '../domain/budget.js';
import type { BudgetDetails, BudgetTeam } from '../db/types.js';
import { buildAndSaveBudgets } from './budget.service.js';
import { planFingerprint, type StatsCheck } from './automaticGameStats.service.js';
import { sendBudgetDraftsByMonth } from './notify.service.js';

export type AutomaticDraftResult =
  | 'not-ready'
  | 'no-draft'
  | 'published'
  | 'already-sent'
  | 'sent';

/** Стабильный отпечаток полного набора готовых протоколов расчётного месяца. */
export function completeStatsFingerprint(checks: StatsCheck[]): string | null {
  if (checks.length === 0 || checks.some((check) => !check.ready || !check.plan)) return null;
  const rows = checks
    .map((check) => `${check.game.id}:${check.game.external_id}:${planFingerprint(check.plan!)}`)
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
/**
 * После готовности последней игры пересобрать существующий черновик следующего
 * месяца и отправить его администраторам. Публикация сбора здесь не выполняется.
 */
export async function refreshAndSendCompletedDraft(
  api: Api,
  month: number,
  year: number,
  checks: StatsCheck[],
  deps: {
    build?: typeof buildAndSaveBudgets;
    send?: typeof sendBudgetDraftsByMonth;
  } = {},
): Promise<AutomaticDraftResult> {
  const fingerprint = completeStatsFingerprint(checks);
  if (!fingerprint) return 'not-ready';

  const teams: BudgetTeam[] = usesCommonBudget(month, year) ? ['COMMON'] : ['RED', 'BLACK'];
  const budgets = (await Promise.all(teams.map((team) => getBudget(team, month, year))))
    .filter((budget): budget is NonNullable<typeof budget> => !!budget);
  if (budgets.length === 0) return 'no-draft';
  if (budgets.some((budget) => budget.message_id != null)) return 'published';

  if (!(await claimAutomaticDraft(month, year, fingerprint))) return 'already-sent';
  try {
    const built = await (deps.build ?? buildAndSaveBudgets)(month, year, undefined, api, 'edit');
    const warnings = built.flatMap((item) =>
      (item.result.details as BudgetDetails).game_stats_warnings ?? []);
    if (warnings.length) throw new Error(`После пересчёта остались непроверенные игры: ${warnings.join('; ')}`);
    const delivery = await (deps.send ?? sendBudgetDraftsByMonth)(api, month, year);
    if (delivery.deliveries === 0) throw new Error('Черновик не доставлен ни одному администратору');
    await markAutomaticDraftSent(month, year);
    return 'sent';
  } catch (err) {
    await markAutomaticDraftFailed(month, year, (err as Error).message);
    throw err;
  }
}
