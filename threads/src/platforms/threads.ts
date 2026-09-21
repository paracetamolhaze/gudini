import { cachedSettings } from "../config/settings.js";
import { attemptStore } from "../db/repos/publishing.js";
import { fetchInbox } from "../services/replies/inbox.js";
import { normalizeThreadsMedia } from "../services/sources/normalize.js";
import { errorMessage } from "../shared/logger.js";
import { PermissionError } from "../threads/errors.js";
import { threadsClient } from "../threads/index.js";
import { ThreadsPublisher } from "../threads/publisher.js";
import type { FoundPost, PlatformAdapter, PlatformInbox, PostMetrics, PublishPostRequest, PublishReplyRequest, PublishedPost } from "./types.js";

/** Threads through the official Graph API: publishing, replies anywhere, keyword search, insights. */
export const threadsAdapter: PlatformAdapter = {
  id: "threads",
  label: "Threads",
  maxChars: () => cachedSettings().platforms.threads.maxChars,
  publicReplyChannel: () => "api",
  configured: () => threadsClient().hasToken,

  async me() {
    const me = await threadsClient().me();
    return { id: me.id, username: me.username, name: me.name };
  },

  async publishPost(req: PublishPostRequest): Promise<PublishedPost> {
    const image = req.image?.url ? { imageUrl: req.image.url, altText: req.image.altText } : {};
    const res = await new ThreadsPublisher(threadsClient(), attemptStore).publishThread({ key: req.key, kind: "post", text: req.text, ...image }, this.maxChars());
    return { id: res.root.id, permalink: res.root.permalink, parts: res.parts, recovered: res.root.recovered };
  },

  async publishReply(req: PublishReplyRequest): Promise<PublishedPost> {
    const res = await new ThreadsPublisher(threadsClient(), attemptStore).publish({ key: req.key, kind: "reply", text: req.text, replyToId: req.replyToId });
    return { id: res.id, permalink: res.permalink, parts: 1, recovered: res.recovered };
  },

  async fetchInbox(opts): Promise<PlatformInbox> {
    const inbox = await fetchInbox(threadsClient(), { ...opts, includeMentions: true });
    const conversations: PlatformInbox["conversations"] = new Map();
    for (const [rootId, msgs] of inbox.conversations) {
      conversations.set(
        rootId,
        msgs.filter((m) => m.id).map((m) => ({ id: m.id, parentId: m.replied_to?.id ?? null, username: m.username ?? "", text: m.text ?? "", timestamp: m.timestamp ? new Date(m.timestamp) : null, raw: m })),
      );
    }
    return {
      items: inbox.items.map((i) => ({ kind: i.kind, id: i.id, text: i.text, username: i.username, timestamp: i.timestamp, permalink: i.permalink, rootPostId: i.rootPostId, parentId: i.parentId, imageUrls: i.imageUrls })),
      conversations,
      notice: inbox.mentionError,
    };
  },

  async searchPosts(opts): Promise<{ found: FoundPost[]; error: string | null }> {
    const client = threadsClient();
    const own = opts.ownUsername.toLowerCase();
    const sinceSec = Math.max(1688540400, Math.floor((Date.now() - opts.lookbackHours * 3_600_000) / 1000));
    const found: FoundPost[] = [];
    let error: string | null = null;
    for (const q of opts.keywords) {
      try {
        const page = await client.keywordSearch({ q, searchType: "RECENT", since: sinceSec, limit: Math.min(50, opts.perKeyword) });
        for (const m of page.data ?? []) {
          if (m.is_reply === true || !m.id) continue;
          if ((m.username ?? "").toLowerCase() === own) continue;
          const p = normalizeThreadsMedia(m);
          if (!p || !p.text) continue;
          found.push({ id: m.id, username: p.authorUsername, text: p.text, publishedAt: p.publishedAt, permalink: m.permalink ?? null, keyword: q });
        }
      } catch (err) {
        error = err instanceof PermissionError ? `keyword_search: нужно разрешение ${err.scope ?? "threads_keyword_search"} (без Advanced Access поиск ограничен своими постами)` : errorMessage(err);
        break;
      }
    }
    return { found, error };
  },

  async metrics(postId: string): Promise<PostMetrics> {
    return threadsClient().postInsights(postId);
  },
};
