import type { ThreadsClient } from "../../threads/client.js";
import { PermissionError } from "../../threads/errors.js";
import type { ThreadsMedia } from "../../threads/types.js";
import { mediaImageUrls } from "../../threads/types.js";

/**
 * What needs answering: replies received across our posts (/{user}/replies), plus @mentions when
 * the token has threads_manage_mentions. The full conversation under each root is fetched once
 * per poll so the decision/writer see the chain, not just the last message.
 */
export interface InboxItem {
  kind: "reply" | "mention";
  id: string;
  text: string;
  username: string;
  timestamp: Date | null;
  permalink: string | null;
  rootPostId: string | null;
  parentId: string | null;
  imageUrls: string[];
  raw: ThreadsMedia;
}

export interface InboxResult {
  items: InboxItem[];
  conversations: Map<string, ThreadsMedia[]>;
  mentionError: string | null;
  truncatedThreads: number;
}

export async function fetchInbox(client: ThreadsClient, opts: { ownUsername: string; lookbackHours: number; maxPerPost: number; includeMentions: boolean }): Promise<InboxResult> {
  const own = opts.ownUsername.toLowerCase();
  const sinceSec = Math.max(1688540400, Math.floor((Date.now() - opts.lookbackHours * 3_600_000) / 1000));
  const items: InboxItem[] = [];
  const seen = new Set<string>();

  // 1. Replies across all our posts (newest first, up to 3 pages).
  let after: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await client.myReplies({ limit: 100, after, since: sinceSec });
    for (const m of res.data ?? []) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const username = (m.username ?? "").trim();
      if (!username || username.toLowerCase() === own) continue;
      const imageUrls = mediaImageUrls(m);
      const text = (m.text ?? "").trim() || (imageUrls.length ? "(image reply)" : "");
      if (!text) continue;
      items.push({
        kind: "reply",
        id: m.id,
        text,
        username,
        timestamp: m.timestamp ? new Date(m.timestamp) : null,
        permalink: m.permalink ?? null,
        rootPostId: m.root_post?.id ?? m.replied_to?.id ?? null,
        parentId: m.replied_to?.id ?? null,
        imageUrls,
        raw: m,
      });
    }
    after = res.paging?.cursors?.after;
    if (!after || !(res.data?.length)) break;
  }

  // 2. Mentions (optional permission).
  let mentionError: string | null = null;
  if (opts.includeMentions) {
    try {
      const res = await client.mentions({ since: sinceSec, limit: 50 });
      for (const m of res.data ?? []) {
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const username = (m.username ?? m.owner?.username ?? "").trim();
        if (!username || username.toLowerCase() === own) continue;
        const imageUrls = mediaImageUrls(m);
        items.push({
          kind: "mention",
          id: m.id,
          text: (m.text ?? "").trim() || (imageUrls.length ? "(mentioned you with an image)" : "(mentioned you)"),
          username,
          timestamp: m.timestamp ? new Date(m.timestamp) : null,
          permalink: m.permalink ?? null,
          rootPostId: m.id,
          parentId: null,
          imageUrls,
          raw: m,
        });
      }
    } catch (err) {
      mentionError = err instanceof PermissionError ? `Mentions API: нужно разрешение ${err.scope ?? "threads_manage_mentions"} на токене (и Advanced Access для не-тестеров)` : err instanceof Error ? err.message : String(err);
    }
  }

  // 3. Conversations for the roots involved (cap per root, newest first).
  const conversations = new Map<string, ThreadsMedia[]>();
  const byRoot = new Map<string, InboxItem[]>();
  for (const it of items) {
    if (!it.rootPostId) continue;
    const list = byRoot.get(it.rootPostId) ?? [];
    list.push(it);
    byRoot.set(it.rootPostId, list);
  }
  let truncatedThreads = 0;
  const kept: InboxItem[] = [];
  for (const [rootId, list] of byRoot) {
    if (list.some((x) => x.kind === "reply")) {
      try {
        const conv = await client.conversation(rootId, { limit: 100 });
        conversations.set(rootId, conv.data ?? []);
      } catch {
        conversations.set(rootId, []);
      }
    }
    list.sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
    if (list.length > opts.maxPerPost) truncatedThreads++;
    kept.push(...list.slice(0, opts.maxPerPost));
  }
  kept.push(...items.filter((i) => !i.rootPostId));
  kept.sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
  return { items: kept, conversations, mentionError, truncatedThreads };
}
