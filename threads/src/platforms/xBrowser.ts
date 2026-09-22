import { cachedSettings } from "../config/settings.js";
import { query } from "../db/pool.js";
import { attemptStore } from "../db/repos/publishing.js";
import { errorMessage } from "../shared/logger.js";
import { readXSession } from "../x/browser/state.js";
import { xBrowser } from "../x/browser/client.js";
import { XBrowserPublisher } from "../x/browser/publisher.js";
import { stripLinks } from "./x.js";
import type { ConversationMsg, FoundPost, InboxItem, PlatformAdapter, PlatformInbox, PostMetrics, PublishPostRequest, PublishQuoteRequest, PublishReplyRequest, PublishedPost } from "./types.js";

/**
 * X through our own browser. Nothing is billed here, so the limits that shaped the API adapter are
 * gone: reading other people costs nothing and replies are not restricted to people who summoned us.
 * What replaces them is restraint — X bans accounts that behave like scripts — so the owner's daily
 * cap still applies, now as a politeness limit rather than a budget.
 */
const SESSION_TTL_MS = 5_000;
let sessionCache: { at: number; connected: boolean; username: string } = { at: 0, connected: false, username: "" };

function session(): { connected: boolean; username: string } {
  if (Date.now() - sessionCache.at > SESSION_TTL_MS) {
    const s = readXSession();
    sessionCache = { at: Date.now(), connected: Boolean(s.connected && s.username), username: s.username ?? "" };
  }
  return sessionCache;
}

/** Tests and the settings screen need the cached answer to drop immediately after a reconnect. */
export function forgetXSessionCache(): void {
  sessionCache = { at: 0, connected: false, username: "" };
}

function outgoingText(text: string): string {
  // Links are still stripped by default: a post whose point is a link reads like an advert, and the
  // owner keeps every link in his profile on purpose.
  return cachedSettings().platforms.x.allowLinks ? text : stripLinks(text);
}

const publisher = () => new XBrowserPublisher(xBrowser(), attemptStore);

async function ourRecentPostIds(): Promise<Set<string>> {
  const rows = await query<{ platform_post_id: string }>(`SELECT platform_post_id FROM publications WHERE platform = 'x' AND published_at >= now() - interval '30 days'`);
  return new Set(rows.map((r) => r.platform_post_id));
}

const toDate = (iso: string | null): Date | null => (iso ? new Date(iso) : null);

export const xBrowserAdapter: PlatformAdapter = {
  id: "x",
  label: "X",
  maxChars: () => cachedSettings().platforms.x.maxChars,
  /** The browser can answer anyone; whether it may is the owner's switch, not a platform limit. */
  publicReplyChannel: () => (cachedSettings().platforms.x.engagementMode === "auto" ? "api" : "manual_or_quote"),
  configured: () => session().connected,

  async me() {
    const local = session();
    if (local.connected) return { id: local.username, username: local.username };
    const me = await xBrowser().me();
    forgetXSessionCache();
    return { id: me.username, username: me.username };
  },

  async publishPost(req: PublishPostRequest): Promise<PublishedPost> {
    const res = await publisher().publishThread({ key: req.key, kind: "post", text: outgoingText(req.text), imagePath: req.image?.path ?? null }, this.maxChars());
    return { id: res.root.id, permalink: res.root.permalink, parts: res.parts, recovered: res.root.recovered };
  },

  async publishReply(req: PublishReplyRequest): Promise<PublishedPost> {
    const res = await publisher().publish({ key: req.key, kind: "reply", text: outgoingText(req.text).slice(0, this.maxChars()), replyToId: req.replyToId });
    return { id: res.id, permalink: res.permalink, parts: 1, recovered: res.recovered };
  },

  async publishQuote(req: PublishQuoteRequest): Promise<PublishedPost> {
    const res = await publisher().publish({ key: req.key, kind: "quote", text: outgoingText(req.text).slice(0, this.maxChars()), quotedId: req.quotedId });
    return { id: res.id, permalink: res.permalink, parts: 1, recovered: res.recovered };
  },

  /**
   * Two sources, because they answer different questions: the comment threads under our own posts,
   * and the mentions tab for everything else that names us.
   */
  async fetchInbox(opts): Promise<PlatformInbox> {
    const client = xBrowser();
    const own = opts.ownUsername.toLowerCase();
    const items: InboxItem[] = [];
    const conversations = new Map<string, ConversationMsg[]>();
    const notices: string[] = [];

    const recent = await query<{ platform_post_id: string }>(
      `SELECT platform_post_id FROM publications WHERE platform = 'x' AND published_at >= now() - ($1 || ' hours')::interval ORDER BY published_at DESC LIMIT 10`,
      [String(Math.max(opts.lookbackHours, 24))],
    );
    for (const row of recent) {
      try {
        const { posts } = await client.thread(row.platform_post_id, opts.maxPerPost);
        for (const p of posts) {
          if (p.username.toLowerCase() === own || !p.text) continue;
          items.push({ kind: "reply", id: p.id, text: p.text, username: p.username, timestamp: toDate(p.timestamp), permalink: p.permalink, rootPostId: row.platform_post_id, parentId: row.platform_post_id, imageUrls: p.imageUrls });
          const list = conversations.get(row.platform_post_id) ?? [];
          list.push({ id: p.id, parentId: row.platform_post_id, username: p.username, text: p.text, timestamp: toDate(p.timestamp) });
          conversations.set(row.platform_post_id, list);
        }
      } catch (err) {
        notices.push(`ветка ${row.platform_post_id}: ${errorMessage(err)}`);
      }
    }

    try {
      const ours = await ourRecentPostIds();
      const { posts } = await client.inbox(30);
      for (const p of posts) {
        if (p.username.toLowerCase() === own || !p.text || ours.has(p.id) || items.some((i) => i.id === p.id)) continue;
        items.push({ kind: "mention", id: p.id, text: p.text, username: p.username, timestamp: toDate(p.timestamp), permalink: p.permalink, rootPostId: p.id, parentId: null, imageUrls: p.imageUrls });
      }
    } catch (err) {
      notices.push(`упоминания: ${errorMessage(err)}`);
    }

    return { items, conversations, notice: notices.length ? `X: ${notices.join("; ")}` : null };
  },

  async searchPosts(opts): Promise<{ found: FoundPost[]; error: string | null }> {
    const settings = cachedSettings().platforms.x;
    if (settings.engagementMode === "off") return { found: [], error: null };
    const own = opts.ownUsername.toLowerCase();
    const lang = settings.language === "ru" ? " lang:ru" : " lang:en";
    const queryText = /\blang:/.test(settings.engagementQuery) ? settings.engagementQuery : `${settings.engagementQuery}${lang}`;
    try {
      const { posts } = await xBrowser().search(queryText, Math.max(10, Math.min(opts.perKeyword, 60)));
      const cutoff = Date.now() - opts.lookbackHours * 3_600_000;
      const found = posts
        .filter((p) => p.username.toLowerCase() !== own && !p.isReply && p.text)
        .filter((p) => {
          const at = toDate(p.timestamp);
          return !at || at.getTime() >= cutoff;
        })
        .map((p) => ({ id: p.id, username: p.username, text: p.text, publishedAt: toDate(p.timestamp), permalink: p.permalink, keyword: "x:search" }));
      return { found, error: null };
    } catch (err) {
      return { found: [], error: `X поиск: ${errorMessage(err)}` };
    }
  },

  async metrics(postId: string): Promise<PostMetrics> {
    const res = await xBrowser().metrics(postId);
    const m = res.metrics;
    return { views: m.views ?? 0, likes: m.likes ?? 0, replies: m.replies ?? 0, reposts: m.reposts ?? 0, quotes: m.quotes ?? 0, shares: m.shares ?? 0 };
  },

  manualReplyUrl(postId: string, text: string): string {
    return `https://x.com/intent/post?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;
  },
};
