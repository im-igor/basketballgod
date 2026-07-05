import { query } from '../pool.js';
import type { Budget, BudgetDetails, Charge, Team } from '../types.js';

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
  const { rows } = await query<Budget>(
    `insert into budgets (team, month, year, total_per_player, details)
     values ($1,$2,$3,$4,$5)
     on conflict (team, month, year) do update set
       total_per_player = excluded.total_per_player,
       details = excluded.details,
       updated_at = now()
     returning *`,
    [input.team, input.month, input.year, input.total_per_player, JSON.stringify(input.details)],
  );
  const budget = rows[0]!;

  await query('delete from charges where budget_id = $1', [budget.id]);
  for (const c of input.charges) {
    await query(
      `insert into charges (budget_id, player_id, tg_login, name, base_amount, game_amount, amount)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [budget.id, c.player_id, c.tg_login, c.name, c.base_amount, c.game_amount, c.amount],
    );
  }
  return budget;
}

/** Обновить итог и details бюджета (без трогания charges). */
export async function updateBudgetDetails(
  budgetId: number,
  totalPerPlayer: number,
  details: BudgetDetails,
): Promise<void> {
  await query(
    'update budgets set total_per_player = $2, details = $3, updated_at = now() where id = $1',
    [budgetId, totalPerPlayer, JSON.stringify(details)],
  );
}

/** Мягко обновить суммы начисления (сохраняя paid/paid_at). */
export async function updateChargeAmount(
  chargeId: number,
  baseAmount: number,
  gameAmount: number,
  amount: number,
): Promise<void> {
  await query(
    'update charges set base_amount = $2, game_amount = $3, amount = $4 where id = $1',
    [chargeId, baseAmount, gameAmount, amount],
  );
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
