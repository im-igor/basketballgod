import { query } from '../pool.js';
import type { Team } from '../types.js';

export type PollDraftStatus = 'pending' | 'sent' | 'skipped';

export interface PollDraftRow {
  id: number;
  team: Team;
  event_uid: string | null;
  question: string;
  options: string[];
  event_start: string | null;
  is_training: boolean;
  forward: boolean;
  status: PollDraftStatus;
  poll_id: string | null;
}

const COLS =
  'id, team, event_uid, question, options, event_start, is_training, forward, status, poll_id';

/** Создать черновик опроса. Возвращает его id. */
export async function createPollDraft(d: {
  team: Team;
  event_uid: string | null;
  question: string;
  options: string[];
  event_start: string | null;
  is_training: boolean;
  forward: boolean;
}): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `insert into poll_drafts (team, event_uid, question, options, event_start, is_training, forward)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      d.team,
      d.event_uid,
      d.question,
      JSON.stringify(d.options),
      d.event_start,
      d.is_training,
      d.forward,
    ],
  );
  return rows[0]!.id;
}

export async function getPollDraft(id: number): Promise<PollDraftRow | null> {
  const { rows } = await query<PollDraftRow>(
    `select ${COLS} from poll_drafts where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function updatePollDraftText(id: number, question: string): Promise<void> {
  await query('update poll_drafts set question = $2 where id = $1', [id, question]);
}

export async function updatePollDraftOptions(id: number, options: string[]): Promise<void> {
  await query('update poll_drafts set options = $2 where id = $1', [id, JSON.stringify(options)]);
}

export async function setPollDraftForward(id: number, forward: boolean): Promise<void> {
  await query('update poll_drafts set forward = $2 where id = $1', [id, forward]);
}

export async function setPollDraftStatus(id: number, status: PollDraftStatus): Promise<void> {
  await query('update poll_drafts set status = $2 where id = $1', [id, status]);
}

export async function setPollDraftSent(id: number, pollId: string | null): Promise<void> {
  await query(
    "update poll_drafts set status = 'sent', poll_id = $2, sent_at = now() where id = $1",
    [id, pollId],
  );
}
