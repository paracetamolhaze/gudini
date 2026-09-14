import { one, query } from "../pool.js";

export type InteractionType = "OWN_POST_REPLY" | "MENTION" | "PUBLIC_POST_REPLY" | "NESTED_REPLY";
export type InteractionStatus = "PENDING" | "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "SENDING" | "SENT" | "SKIPPED" | "FAILED" | "REJECTED";

export interface InteractionRow {
  id: string;
  type: InteractionType;
  target_post_id: string | null;
  target_reply_id: string | null;
  root_post_id: string | null;
  publication_id: string | null;
  target_username: string;
  target_text: string;
  target_permalink: string | null;
  target_published_at: Date | null;
  our_text: string | null;
  decision: string | null;
  reason: string | null;
  decision_json: unknown;
  status: InteractionStatus;
  published_reply_id: string | null;
  permalink: string | null;
  error: string | null;
  prompt_version: string | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

export async function insertInteraction(input: {
  type: InteractionType;
  targetPostId: string | null;
  targetReplyId: string | null;
  rootPostId: string | null;
  publicationId: string | null;
  targetUsername: string;
  targetText: string;
  targetPermalink: string | null;
  targetPublishedAt: Date | null;
}): Promise<InteractionRow | null> {
  // Unique per (type, target_reply_id) / (PUBLIC_POST_REPLY, target_post_id): a second poll inserts nothing.
  return one<InteractionRow>(
    `INSERT INTO interactions (type, target_post_id, target_reply_id, root_post_id, publication_id, target_username, target_text, target_permalink, target_published_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
     ON CONFLICT DO NOTHING RETURNING *`,
    [input.type, input.targetPostId, input.targetReplyId, input.rootPostId, input.publicationId, input.targetUsername, input.targetText, input.targetPermalink, input.targetPublishedAt],
  );
}

export async function getInteraction(id: string): Promise<InteractionRow | null> {
  return one<InteractionRow>(`SELECT * FROM interactions WHERE id = $1`, [id]);
}

export async function listInteractions(opts: { type?: string; status?: string | string[]; limit?: number; before?: string }): Promise<InteractionRow[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.type) conds.push(`type = ${push(opts.type)}`);
  if (opts.status) conds.push(`status = ANY(${push(Array.isArray(opts.status) ? opts.status : opts.status.split(","))}::text[])`);
  if (opts.before) conds.push(`created_at < ${push(opts.before)}`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return query<InteractionRow>(`SELECT * FROM interactions ${where} ORDER BY created_at DESC LIMIT ${push(Math.min(200, opts.limit ?? 50))}`, params);
}

export async function updateInteraction(
  id: string,
  patch: Partial<{ our_text: string | null; decision: string | null; reason: string | null; decision_json: unknown; status: InteractionStatus; published_reply_id: string | null; permalink: string | null; error: string | null; prompt_version: string | null; model: string | null; sent_at: Date | null }>,
): Promise<InteractionRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "decision_json") add(k, JSON.stringify(v), "::jsonb");
    else add(k, v);
  }
  if (!sets.length) return getInteraction(id);
  params.push(id);
  return one<InteractionRow>(`UPDATE interactions SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
}

export async function transitionInteraction(id: string, from: InteractionStatus[], to: InteractionStatus): Promise<InteractionRow | null> {
  return one<InteractionRow>(`UPDATE interactions SET status = $3, updated_at = now() WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`, [id, from, to]);
}

export async function pendingInteractions(limit = 30): Promise<InteractionRow[]> {
  return query<InteractionRow>(`SELECT * FROM interactions WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT $1`, [limit]);
}

export async function knownTargetIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await query<{ id: string }>(`SELECT COALESCE(target_reply_id, target_post_id) AS id FROM interactions WHERE target_reply_id = ANY($1::text[]) OR target_post_id = ANY($1::text[])`, [ids]);
  return new Set(rows.map((r) => r.id));
}

// ---- conversation memory -------------------------------------------------------------------

export interface ConversationMessage {
  message_id: string;
  root_post_id: string;
  parent_id: string | null;
  username: string;
  text: string;
  is_ours: boolean;
  platform_timestamp: Date | null;
}

export async function upsertConversationMessages(messages: Array<ConversationMessage & { media?: unknown; raw?: unknown }>): Promise<void> {
  for (const m of messages) {
    await query(
      `INSERT INTO conversation_messages (root_post_id, message_id, parent_id, username, text, is_ours, media_json, platform_timestamp, raw_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
       ON CONFLICT (message_id) DO UPDATE SET text = EXCLUDED.text, is_ours = EXCLUDED.is_ours, parent_id = COALESCE(EXCLUDED.parent_id, conversation_messages.parent_id)`,
      [m.root_post_id, m.message_id, m.parent_id, m.username, m.text, m.is_ours, JSON.stringify(m.media ?? []), m.platform_timestamp, JSON.stringify(m.raw ?? null)],
    );
  }
}

export async function conversationChain(rootPostId: string, leafId: string): Promise<ConversationMessage[]> {
  const rows = await query<ConversationMessage>(`SELECT message_id, root_post_id, parent_id, username, text, is_ours, platform_timestamp FROM conversation_messages WHERE root_post_id = $1`, [rootPostId]);
  const byId = new Map(rows.map((r) => [r.message_id, r]));
  const chain: ConversationMessage[] = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.message_id)) {
    seen.add(cur.message_id);
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

export async function repliesFromUserInThread(rootPostId: string, username: string): Promise<string[]> {
  const rows = await query<{ text: string }>(`SELECT text FROM conversation_messages WHERE root_post_id = $1 AND lower(username) = lower($2) ORDER BY platform_timestamp ASC`, [rootPostId, username]);
  return rows.map((r) => r.text);
}
