import { GameStatsNotReadyError } from '../services/automaticGameStats.service.js';
import type { Budget } from '../db/types.js';
import { sharedCoachBudgetsReady } from '../domain/budget.js';

export function publicationBlockReasons(budgets: Budget[], shared: boolean): string[] {
  const reasons: string[] = [];
  if (budgets.some((b) => (b.details?.game_stats_warnings?.length ?? 0)>0)) {
    reasons.push('Не все игры проверены. Базовая часть рассчитана, но игровые взносы ещё не готовы. Дождись завершения матчей и появления протоколов либо внеси сыгравших вручную в разделе «Игры», затем пересобери бюджет.');
  }
  if (budgets.some((b) => b.details?.correction && !b.details.correction.reviewed)) {
    reasons.push('Не подтверждены корректировки. Проверь их в черновике и нажми «Подтвердить корректировки».');
  }
  if (shared && !sharedCoachBudgetsReady(budgets.find((b)=>b.team==='RED')??null,budgets.find((b)=>b.team==='BLACK')??null)) {
    reasons.push('Общий расчёт команд не согласован. Пересобери бюджеты обеих команд и проверь суммы.');
  }
  return reasons;
}

export function publicationErrorMessage(error: unknown): string {
  if (error instanceof GameStatsNotReadyError) {
    return 'Отправка сбора заблокирована: статистика игр ещё не готова. Базовый черновик сохранён. ' +
      'Проверь список матчей в разделе «Игры»: дождись протоколов или укажи фактически сыгравших вручную, затем пересобери бюджет. Подробности: ' + error.warnings.join('; ');
  }
  return `Отправка сбора заблокирована: ${error instanceof Error ? error.message : 'неизвестная ошибка. Повтори попытку позже'}`;
}
