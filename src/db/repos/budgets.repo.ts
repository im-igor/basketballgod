import { budgetTransaction, query, withBudgetOperation } from '../pool.js';
import type { Budget, BudgetDetails, Charge, ExtraFee, ExtraFeeAllocation, Game, Team } from '../types.js';
import { extraFeesForPlayer, sumMoney } from '../../domain/extraFees.js';

export interface ChargeInput {
  player_id: number | null;
  tg_login: string;
  name: string | null;
  base_amount: number;
  game_amount: number;
  amount: number;
}

/** Создать/перезаписать бюджет команды за месяц вместе с начислениями (в транзакции). */
export async function saveBudget(input: {
  team: Team;
  month: number;
  year: number;
  total_per_player: number;
  details: BudgetDetails;
  charges: ChargeInput[];
}): Promise<Budget> {
  return budgetTransaction(async (client) => {
    const { rows } = await client.query<Budget>(
      `insert into budgets (team, month, year, total_per_player, details)
       values ($1,$2,$3,$4,$5)
       on conflict (team, month, year) do update set
         total_per_player = excluded.total_per_player,
         details = excluded.details,
         updated_at = now()
       where budgets.message_id is null
       returning *`,
      [input.team, input.month, input.year, input.total_per_player, JSON.stringify(input.details)],
    );
    const budget = rows[0];
    if (!budget) throw new Error('Опубликованный бюджет нельзя изменить');

    const fees = (await client.query<ExtraFee>('select * from extra_fees order by id')).rows;
    const allocations = (await client.query<ExtraFeeAllocation>('select * from extra_fee_allocations')).rows;
    const games = (await client.query<Game>(
      'select * from games where month = $1 and year = $2', [input.month, input.year],
    )).rows;

    // Удаляем только выбывших из бюджета. Остальным сохраняем id и отметки оплат.
    const logins = input.charges.map((c) => c.tg_login);
    await client.query('delete from charges where budget_id = $1 and not (tg_login = any($2::text[]))', [budget.id, logins]);
    await client.query('delete from extra_fee_allocations where budget_id = $1', [budget.id]);
    for (const c of input.charges) {
      const extraItems = extraFeesForPlayer({
        playerId: c.player_id, login: c.tg_login, team: input.team,
        budgetId: budget.id, period: input.year * 100 + input.month, fees, allocations, games,
      });
      const extraAmount = sumMoney(extraItems.map((item) => item.amount));
      for (const item of extraItems) {
        await client.query(
          `insert into extra_fee_allocations (fee_id, player_id, budget_id, tg_login, title, amount)
           values ($1,$2,$3,$4,$5,$6)`,
          [item.fee_id, c.player_id, budget.id, c.tg_login, item.title, item.amount],
        );
      }
      await client.query(
        `insert into charges (budget_id, player_id, tg_login, name, base_amount, game_amount, extra_amount, extra_items, amount)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (budget_id, tg_login) do update set
           player_id = excluded.player_id, name = excluded.name,
           base_amount = excluded.base_amount, game_amount = excluded.game_amount,
           extra_amount = excluded.extra_amount, extra_items = excluded.extra_items, amount = excluded.amount`,
        [budget.id, c.player_id, c.tg_login, c.name, c.base_amount, c.game_amount,
          extraAmount, JSON.stringify(extraItems), sumMoney([c.base_amount, c.game_amount, extraAmount])],
      );
    }
    return budget;
  });
}

export async function getBudget(
  team: Team,
  month: number,
  year: number,
): Promise<Budget | null> {
  const { rows } = await query<Budget>(
    'select * from budgets where team = $1 and month = $2 and year = $3',
    [team, month, year],
  );
  return rows[0] ?? null;
}

export async function getBudgetById(id: number): Promise<Budget | null> {
  const { rows } = await query<Budget>('select * from budgets where id = $1', [id]);
  return rows[0] ?? null;
}

export async function listBudgets(): Promise<Budget[]> {
  const { rows } = await query<Budget>(
    'select * from budgets order by year desc, month desc, team',
  );
  return rows;
}

/** Удалить бюджет одной команды; связанные начисления удаляются каскадно. */
export async function deleteBudget(
  team: Team,
  month: number,
  year: number,
): Promise<Budget | null> {
  return withBudgetOperation(() => budgetTransaction(async (client) => {
    const { rows } = await client.query<Budget>(
      'delete from budgets where team = $1 and month = $2 and year = $3 and message_id is null returning *',
      [team, month, year],
    );
    return rows[0] ?? null;
  }));
}

/** Physically remove both drafts and their cascading charges/fee allocations atomically. */
export async function deleteDraftMonth(month: number, year: number): Promise<number> {
  return withBudgetOperation(() => budgetTransaction(async client => {
    const { rows } = await client.query<Budget>(
      'select * from budgets where month=$1 and year=$2 for update', [month, year],
    );
    if (rows.some(b => b.message_id != null)) throw new Error('Опубликованный бюджет нельзя удалить');
    const result = await client.query('delete from budgets where month=$1 and year=$2 returning id', [month, year]);
    return result.rows.length;
  }));
}

export async function setBudgetMessage(
  budgetId: number,
  chatId: number,
  messageId: number,
): Promise<void> {
  await query('update budgets set chat_id = $2, message_id = $3, updated_at = now() where id = $1', [
    budgetId,
    chatId,
    messageId,
  ]);
}

export async function getCharges(budgetId: number): Promise<Charge[]> {
  const { rows } = await query<Charge>(
    'select * from charges where budget_id = $1 order by name',
    [budgetId],
  );
  return rows;
}

/** Начисления для списка месяцев одним запросом, без запроса на каждый бюджет. */
export async function getChargesForBudgets(budgetIds: number[]): Promise<Charge[]> {
  if (!budgetIds.length) return [];
  const { rows } = await query<Charge>(
    'select * from charges where budget_id = any($1::int[]) order by budget_id, name',
    [budgetIds],
  );
  return rows;
}

/** Сохранить снимок проверки чата без перезаписи расчёта и отметок оплат. */
export async function setBudgetChatCheck(budgetId: number, check: NonNullable<BudgetDetails['chat_check']>): Promise<void> {
  await query(
    `update budgets set details = jsonb_set(details, '{chat_check}', $2::jsonb, true), updated_at = now()
     where id = $1`,
    [budgetId, JSON.stringify(check)],
  );
}

export async function setChargePaid(chargeId: number, paid: boolean): Promise<Charge | null> {
  const { rows } = await query<Charge>(
    `update charges set paid = $2, paid_at = case when $2 then now() else null end
     where id = $1 returning *`,
    [chargeId, paid],
  );
  return rows[0] ?? null;
}

/** Переключить статус оплаты начисления (paid ↔ не paid), обновив paid_at. */
export async function toggleChargePaid(chargeId: number): Promise<Charge | null> {
  const { rows } = await query<Charge>(
    `update charges
        set paid = not paid,
            paid_at = case when paid then null else now() end
      where id = $1 returning *`,
    [chargeId],
  );
  return rows[0] ?? null;
}

export async function setChargePaidByLogin(
  budgetId: number,
  tgLogin: string,
  paid: boolean,
): Promise<Charge | null> {
  const { rows } = await query<Charge>(
    `update charges set paid = $3, paid_at = case when $3 then now() else null end
     where budget_id = $1 and lower(tg_login) = lower($2) returning *`,
    [budgetId, tgLogin, paid],
  );
  return rows[0] ?? null;
}

export async function getDebtors(budgetId: number): Promise<Charge[]> {
  const { rows } = await query<Charge>(
    'select * from charges where budget_id = $1 and paid = false order by name',
    [budgetId],
  );
  return rows;
}
