import { query } from '../pool.js';
import type { Tag } from '../types.js';

export type TagInput = {
  tag_key: string;
  tag_value: string;
  description?: string | null;
  sort_order?: number;
};

/** Все теги справочника в порядке сортировки. */
export async function listTags(): Promise<Tag[]> {
  const { rows } = await query<Tag>(
    `select id, tag_key, tag_value, description, sort_order
     from tags order by sort_order, tag_key, tag_value`,
  );
  return rows;
}

/** Добавить или обновить тег по (tag_key, tag_value). */
export async function upsertTag(t: TagInput): Promise<Tag> {
  const { rows } = await query<Tag>(
    `insert into tags (tag_key, tag_value, description, sort_order)
     values ($1, $2, $3, coalesce($4, 0))
     on conflict (tag_key, tag_value) do update set
       description = excluded.description,
       sort_order  = excluded.sort_order
     returning id, tag_key, tag_value, description, sort_order`,
    [t.tag_key, t.tag_value, t.description ?? null, t.sort_order ?? null],
  );
  return rows[0]!;
}

export async function deleteTag(id: number): Promise<void> {
  await query('delete from tags where id = $1', [id]);
}
