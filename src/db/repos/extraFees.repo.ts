import { budgetTransaction, query } from '../pool.js';
import type { ExtraFee, ExtraFeeAllocation, Team } from '../types.js';
import type { ExtraFeeInput } from '../../domain/extraFees.js';

export async function listExtraFees(): Promise<ExtraFee[]> {
  return (await query<ExtraFee>('select * from extra_fees order by id desc')).rows;
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
  const { rows } = await query<ExtraFee>(
    `insert into extra_fees (title, amount_per_player, team, mode, league, start_period, end_period)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [input.title, input.amount_per_player, input.team, input.mode, input.league, input.start_period, input.end_period],
  );
  return rows[0]!;
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
