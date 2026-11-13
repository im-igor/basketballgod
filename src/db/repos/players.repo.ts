import { query } from '../pool.js';
import type { Player, PlayerStatus, PlayerTeam, Team } from '../types.js';
import { computeActivityDates } from '../../domain/activity.js';

export async function listPlayers(team?: Team): Promise<Player[]> {
  const { rows } = team
    ? await query<Player>("select * from players where team = $1 or team = 'BOTH' order by name", [team])
    : await query<Player>('select * from players order by team, name');
  return rows;
}

export async function listActive(team: Team): Promise<Player[]> {
  const { rows } = await query<Player>(
    "select * from players where (team = $1 or team = 'BOTH') and active = true order by name",
    [team],
  );
  return rows;
}

export async function getByLogin(tgLogin: string): Promise<Player | null> {
  const { rows } = await query<Player>('select * from players where lower(tg_login) = lower($1)', [
    tgLogin,
  ]);
  return rows[0] ?? null;
}

/** Найти игрока по числовому Telegram ID из системного chat_member-обновления. */
export async function getByTelegramUserId(tgUserId: number): Promise<Player | null> {
  const { rows } = await query<Player>('select * from players where tg_user_id = $1', [tgUserId]);
  return rows[0] ?? null;
}

export async function upsertPlayer(p: {
  name: string;
  tg_login: string;
  team: PlayerTeam;
  is_employee?: boolean;
  active?: boolean;
  active_from?: string | null;
  active_to?: string | null;
  notes?: string | null;
}): Promise<Player> {
  const { rows } = await query<Player>(
    `insert into players (name, tg_login, team, is_employee, active, active_from, active_to, notes)
     values ($1,$2,$3,$4,coalesce($5,true),$6,$7,$8)
     on conflict (tg_login) do update set
       name = excluded.name,
       team = excluded.team,
       is_employee = excluded.is_employee,
       active = excluded.active,
       active_from = excluded.active_from,
       active_to = excluded.active_to,
       notes = excluded.notes,
       updated_at = now()
     returning *`,
    [
      p.name,
      p.tg_login,
      p.team,
      p.is_employee ?? false,
      p.active ?? null,
      p.active_from ?? null,
      p.active_to ?? null,
      p.notes ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Установить статус активности и диапазон дат.
 * При активации задаём active_from и ОЧИЩАЕМ active_to (иначе осталась бы устаревшая
 * дата окончания от прошлой деактивации, которая выкидывала бы игрока из расчёта).
 * При деактивации задаём active_to, сохраняя active_from.
 */
export async function setActive(
  tgLogin: string,
  active: boolean,
  activeFrom: string | null,
  activeTo: string | null,
): Promise<Player | null> {
  const { rows } = await query<Player>(
    `update players set
       active = $2,
       active_from = case when $2 then $3::date else active_from end,
       active_to   = case when $2 then null else $4::date end,
       updated_at = now()
     where lower(tg_login) = lower($1)
     returning *`,
    [tgLogin, active, activeFrom, activeTo],
  );
  return rows[0] ?? null;
}

/** Меняем команду и активность атомарно; снятие активности сохраняет заявку. */
export async function setPlayerStatus(tgLogin: string, status: PlayerStatus): Promise<Player | null> {
  const active = status !== 'INACTIVE';
  const dates = computeActivityDates(active);
  const { rows } = await query<Player>(
    `update players set
       team = case when $2 = 'INACTIVE' then team else $2 end,
       active_from = case when not active and $3 then $4::date else active_from end,
       active_to = case when $3 then null when active then $5::date else active_to end,
       active = $3,
       updated_at = now()
     where lower(tg_login) = lower($1) returning *`,
    [tgLogin, status, active, dates.active_from, dates.active_to],
  );
  return rows[0] ?? null;
}

/** Меняем только признак сотрудника, не перезаписывая остальные поля игрока. */
export async function setPlayerEmployee(tgLogin: string, isEmployee: boolean): Promise<Player | null> {
  const { rows } = await query<Player>(
    `update players set is_employee = $2, updated_at = now()
     where lower(tg_login) = lower($1)
     returning *`,
    [tgLogin, isEmployee],
  );
  return rows[0] ?? null;
}

/** Меняем только примечание, не перезаписывая остальные поля игрока. */
export async function setPlayerNotes(tgLogin: string, notes: string | null): Promise<Player | null> {
  const { rows } = await query<Player>(
    `update players set notes = $2, updated_at = now()
     where lower(tg_login) = lower($1)
     returning *`,
    [tgLogin, notes],
  );
  return rows[0] ?? null;
}

export async function linkTelegramUser(
  tgLogin: string,
  tgUserId: number,
): Promise<boolean> {
  const { rows } = await query<{ id: number }>('update players set tg_user_id = $2, updated_at = now() where lower(tg_login) = lower($1) returning id', [
    tgLogin,
    tgUserId,
  ]);
  return rows.length > 0;
}

export async function deletePlayer(id: number): Promise<void> {
  await query('delete from players where id = $1', [id]);
}
