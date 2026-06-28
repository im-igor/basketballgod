import { query } from '../pool.js';
import type { Team } from '../types.js';

export interface PollVoteRow {
  tg_user_id: number;
  tg_username: string | null;
  full_name: string | null;
  option_ids: number[];
}

export async function savePollSession(s: {
  poll_id: string;
  event_uid: string | null;
  team: Team;
  chat_id: number;
  message_id: number;
  thread_id: number | null;
  question: string;
  options: string[];
  event_start: string | null;
}): Promise<void> {
  await query(
    `insert into poll_sessions (poll_id, event_uid, team, chat_id, message_id, thread_id, question, options, event_start)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (poll_id) do nothing`,
    [
      s.poll_id,
      s.event_uid,
      s.team,
      s.chat_id,
      s.message_id,
      s.thread_id,
      s.question,
      JSON.stringify(s.options),
      s.event_start,
    ],
  );
}

export async function pollSessionExists(pollId: string): Promise<boolean> {
  const { rows } = await query<{ ok: boolean }>(
    'select true as ok from poll_sessions where poll_id = $1',
    [pollId],
  );
  return rows.length > 0;
}

export async function upsertVote(v: {
  poll_id: string;
  tg_user_id: number;
  tg_username: string | null;
  full_name: string | null;
  option_ids: number[];
}): Promise<void> {
  // Пустой массив option_ids = игрок отозвал голос → убираем запись.
  if (v.option_ids.length === 0) {
    await query('delete from poll_votes where poll_id = $1 and tg_user_id = $2', [
      v.poll_id,
      v.tg_user_id,
    ]);
    return;
  }
  await query(
    `insert into poll_votes (poll_id, tg_user_id, tg_username, full_name, option_ids)
     values ($1,$2,$3,$4,$5)
     on conflict (poll_id, tg_user_id) do update set
       tg_username = excluded.tg_username,
       full_name = excluded.full_name,
       option_ids = excluded.option_ids,
       voted_at = now()`,
    [v.poll_id, v.tg_user_id, v.tg_username, v.full_name, v.option_ids],
  );
}

export async function getVotes(pollId: string): Promise<PollVoteRow[]> {
  const { rows } = await query<PollVoteRow>(
    'select tg_user_id, tg_username, full_name, option_ids from poll_votes where poll_id = $1',
    [pollId],
  );
  return rows;
}
