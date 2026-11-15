import { budgetTransaction, query } from '../pool.js';
import type { ExtraFee, ExtraFeeAllocation, Team } from '../types.js';
import type { ExtraFeeInput, ExtraFeeRuleInput } from '../../domain/extraFees.js';

const feesSql = `select f.*,
  coalesce(array_agg(r.player_id order by r.player_id) filter (where r.player_id is not null), '{}') as recipient_player_ids
  from extra_fees f left join extra_fee_recipients r on r.fee_id = f.id
  group by f.id`;

export async function listExtraFees(): Promise<ExtraFee[]> {
  return (await query<ExtraFee>(`${feesSql} order by f.id desc`)).rows;
}

export interface AllocationView extends ExtraFeeAllocation {
  name: string | null;
  team: Team;
  month: number;
  year: number;
  paid: boolean;
}

export async function listExtraFeeAllocations(): Promise<AllocationView[]> {
  return (await query<AllocationView>(
    `select a.*, c.name, b.team, b.month, b.year, coalesce(c.paid, false) as paid
     from extra_fee_allocations a join budgets b on b.id = a.budget_id
     left join charges c on c.budget_id = a.budget_id and lower(c.tg_login) = lower(a.tg_login)
     order by b.year, b.month, b.team, c.name`,
  )).rows;
}

export async function createExtraFee(input: ExtraFeeInput): Promise<ExtraFee> {
  return budgetTransaction(async (client) => {
    // Старые внутренние вызовы до миграции не передавали эти поля: ALL остаётся
    // безопасным и обратно совместимым значением по умолчанию.
    const recipientScope = input.recipient_scope ?? 'ALL';
    const playerIds = input.player_ids ?? [];
    const { rows } = await client.query<ExtraFee>(
      `insert into extra_fees (title, amount_per_player, team, mode, league, start_period, end_period, recipient_scope)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [input.title, input.amount_per_player, input.team, input.mode, input.league, input.start_period, input.end_period, recipientScope],
    );
    const fee = rows[0]!;
    if (recipientScope === 'SELECTED') {
      await client.query(
        `insert into extra_fee_recipients (fee_id, player_id)
         select $1, id from players where id = any($2::int[])`,
        [fee.id, playerIds],
      );
    }
    return { ...fee, recipient_player_ids: recipientScope === 'SELECTED' ? playerIds : [] };
  });
}

/** Меняет только будущую логику; уже назначенные начисления остаются историей. */
export async function updateExtraFeeRule(id: number, input: ExtraFeeRuleInput): Promise<boolean> {
  return budgetTransaction(async (client) => {
    const result = await client.query(
      `update extra_fees set team=$2, mode=$3, league=$4, recipient_scope=$5
       where id=$1`,
      [id, input.team, input.mode, input.league, input.recipient_scope],
    );
    if (result.rowCount !== 1) return false;
    await client.query('delete from extra_fee_recipients where fee_id=$1', [id]);
    if (input.recipient_scope === 'SELECTED') {
      await client.query(
        `insert into extra_fee_recipients (fee_id, player_id)
         select $1, id from players where id = any($2::int[])`,
        [id, input.player_ids],
      );
    }
    return true;
  });
}

export async function setExtraFeeActive(id: number, active: boolean): Promise<void> {
  await budgetTransaction(async (client) => {
    await client.query('update extra_fees set active = $2 where id = $1', [id, active]);
  });
}

/** Ошибочно заведённый сбор можно удалить только до первого начисления. */
export async function deleteUnusedExtraFee(id: number): Promise<boolean> {
  return budgetTransaction(async (client) => {
    const result = await client.query(
      `delete from extra_fees where id = $1
       and not exists (select 1 from extra_fee_allocations where fee_id = $1)`, [id],
    );
    return result.rowCount === 1;
  });
}
