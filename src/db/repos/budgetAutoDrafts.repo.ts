import { query } from '../pool.js';

/**
 * Зарезервировать отправку финального черновика для конкретного снимка статистики.
 * Тот же успешно отправленный снимок повторно не обрабатывается. Зависшую отправку
 * можно безопасно подобрать через два часа (Telegram не поддерживает idempotency key,
 * поэтому после аварии в узком окне возможен повтор, но обычные cron-повторы защищены).
 */
export async function claimAutomaticDraft(
  month: number,
  year: number,
  fingerprint: string,
): Promise<boolean> {
  const { rows } = await query<{ claimed: boolean }>(
    `insert into budget_auto_draft_notifications(month,year,fingerprint,status,claimed_at,sent_at,error)
     values($1,$2,$3,'sending',now(),null,null)
     on conflict(month,year) do update set
       fingerprint=excluded.fingerprint,status='sending',claimed_at=now(),sent_at=null,error=null
     where budget_auto_draft_notifications.fingerprint <> excluded.fingerprint
        or budget_auto_draft_notifications.status = 'failed'
        or (budget_auto_draft_notifications.status = 'sending'
            and budget_auto_draft_notifications.claimed_at < now() - interval '2 hours')
     returning true as claimed`,
    [month, year, fingerprint],
  );
  return rows[0]?.claimed === true;
}
export async function markAutomaticDraftSent(month: number, year: number): Promise<void> {
  await query(
    `update budget_auto_draft_notifications
     set status='sent',sent_at=now(),error=null where month=$1 and year=$2`,
    [month, year],
  );
}

export async function markAutomaticDraftFailed(month: number, year: number, error: string): Promise<void> {
  await query(
    `update budget_auto_draft_notifications
     set status='failed',error=$3 where month=$1 and year=$2`,
    [month, year, error.slice(0, 1000)],
  );
}
