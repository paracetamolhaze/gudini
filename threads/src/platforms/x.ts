import { cachedSettings } from "../config/settings.js";
import { one, query } from "../db/pool.js";
import { attemptStore } from "../db/repos/publishing.js";
import { errorMessage } from "../shared/logger.js";
import { xClient } from "../x/index.js";
import { XPublisher } from "../x/publisher.js";
import type { XPost } from "../x/client.js";
import { xPaidReadsToday } from "./usage.js";
import type { ConversationMsg, FoundPost, InboxItem, PlatformAdapter, PlatformInbox, PostMetrics, PublishPostRequest, PublishQuoteRequest, PublishReplyRequest, PublishedPost } from "./types.js";

/**
 * X through API v2. Three things shape this adapter:
 *   - reading other people's posts is billed per post → a daily read budget guards search and mentions;
 *   - the API only accepts replies to authors who mentioned or quoted us → answering commenters under
 *     our own posts works ("summoned"), cold replies do not: those go out by hand or as quote posts;
 *   - a post with a link costs an order of magnitude more → links are stripped unless allowed.
 */
const CURSOR_KEY = "x_mentions_cursor";

async function readCursor(): Promise<string | undefined> {
  const row = await one<{ value: { sinceId?: string } }>(`SELECT value FROM settings WHERE key = $1`, [CURSOR_KEY]);
  return row?.value?.sinceId;
}

async function writeCursor(sinceId: string): Promise<void> {
  await query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [CURSOR_KEY, JSON.stringify({ sinceId })]);
}

async function readBudgetLeft(): Promise<number> {
  return Math.max(0, cachedSettings().platforms.x.dailyReadBudget - (await xPaidReadsToday()));
}

const permalinkOf = (username: string | undefined, id: string): string => (username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`);
const parentOf = (p: XPost): string | null => p.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? null;

/** X adds a t.co link for every URL; without permission for links the text goes out clean. */
export function stripLinks(text: string): string {
  return text
    .replace(/\s*\bhttps?:\/\/\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function outgoingText(text: string): string {
  return cachedSettings().platforms.x.allowLinks ? text : stripLinks(text);
}

export const xAdapter: PlatformAdapter = {
  id: "x",
  label: "X",
  maxChars: () => cachedSettings().platforms.x.maxChars,
  publicReplyChannel: () => "manual_or_quote",
  configured: () => xClient().hasCredentials,

  async me() {
    const client = xClient();
    // users/me is a paid read; the accounts row remembers the answer across restarts.
    const known = await one<{ username: string; platform_user_id: string }>(`SELECT username, platform_user_id FROM accounts WHERE platform = 'x' ORDER BY updated_at DESC LIMIT 1`).catch(() => null);
    if (known?.platform_user_id) client.seedIdentity({ id: known.platform_user_id, username: known.username });
    const me = await client.me();
    return { id: me.id, username: me.username, name: me.name };
  },

  async publishPost(req: PublishPostRequest): Promise<PublishedPost> {
    const res = await new XPublisher(xClient(), attemptStore).publishThread({ key: req.key, kind: "post", text: outgoingText(req.text), imagePath: req.image?.path ?? null }, this.maxChars());
    return { id: res.root.id, permalink: res.root.permalink, parts: res.parts, recovered: res.root.recovered };
  },

  async publishReply(req: PublishReplyRequest): Promise<PublishedPost> {
    const res = await new XPublisher(xClient(), attemptStore).publish({ key: req.key, kind: "reply", text: outgoingText(req.text).slice(0, this.maxChars()), replyToId: req.replyToId, summoned: true });
    return { id: res.id, permalink: res.permalink, parts: 1, recovered: res.recovered };
  },

  async publishQuote(req: PublishQuoteRequest): Promise<PublishedPost> {
    const res = await new XPublisher(xClient(), attemptStore).publish({ key: req.key, kind: "quote", text: outgoingText(req.text).slice(0, this.maxChars()), quotedId: req.quotedId });
    return { id: res.id, permalink: res.permalink, parts: 1, recovered: res.recovered };
  },

  async fetchInbox(opts): Promise<PlatformInbox> {
    const empty: PlatformInbox = { items: [], conversations: new Map(), notice: null };
    const budget = await readBudgetLeft();
    if (budget <= 0) return { ...empty, notice: "X: дневной бюджет чтения исчерпан, новые комментарии подтянутся завтра (лимит в настройках X)" };
    const client = xClient();
    const sinceId = await readCursor();
    const { posts, newestId } = await client.mentions({ sinceId, startTime: new Date(Date.now() - opts.lookbackHours * 3_600_000), max: Math.max(5, Math.min(50, budget)) });
    if (newestId) await writeCursor(newestId);
    const own = opts.ownUsername.toLowerCase();
    const ours = new Set((await query<{ platform_post_id: string }>(`SELECT platform_post_id FROM publications WHERE platform = 'x' AND published_at >= now() - interval '30 days'`)).map((r) => r.platform_post_id));
    const items: InboxItem[] = [];
    const conversations = new Map<string, ConversationMsg[]>();
    for (const p of posts) {
      const username = (p.author_username ?? "").trim();
      if (!username || username.toLowerCase() === own) continue;
      const root = p.conversation_id ?? p.id;
      const parent = parentOf(p);
      // A reply inside a conversation we started is a comment; anything else that names us is a mention.
      const underOurPost = ours.has(root) || (parent !== null && ours.has(parent));
      const text = p.text.replace(/^(?:@\w+\s+)+/, "").trim();
      if (!text) continue;
      items.push({ kind: underOurPost ? "reply" : "mention", id: p.id, text, username, timestamp: p.created_at ? new Date(p.created_at) : null, permalink: permalinkOf(username, p.id), rootPostId: underOurPost ? root : p.id, parentId: underOurPost ? parent : null, imageUrls: [] });
      if (underOurPost) {
        const list = conversations.get(root) ?? [];
        list.push({ id: p.id, parentId: parent, username, text, timestamp: p.created_at ? new Date(p.created_at) : null, raw: p });
        conversations.set(root, list);
      }
    }
    return { items, conversations, notice: null };
  },

  async searchPosts(opts): Promise<{ found: FoundPost[]; error: string | null }> {
    const settings = cachedSettings().platforms.x;
    if (settings.engagementMode === "off") return { found: [], error: null };
    const budget = await readBudgetLeft();
    if (budget < 10) return { found: [], error: "X: дневной бюджет чтения исчерпан — поиск чужих постов пропущен" };
    const own = opts.ownUsername.toLowerCase();
    try {
      // One query per tick: every returned post is billed, so the owner's query string decides the cost.
      const lang = settings.language === "ru" ? " lang:ru" : " lang:en";
      const queryText = /\blang:/.test(settings.engagementQuery) ? settings.engagementQuery : `${settings.engagementQuery}${lang}`;
      const posts = await xClient().searchRecent({ query: queryText, max: Math.max(10, Math.min(opts.perKeyword, budget)), startTime: new Date(Date.now() - opts.lookbackHours * 3_600_000) });
      const found: FoundPost[] = [];
      for (const p of posts) {
        const username = (p.author_username ?? "").trim();
        if (!username || username.toLowerCase() === own) continue;
        if (p.referenced_tweets?.some((r) => r.type === "replied_to" || r.type === "retweeted")) continue;
        found.push({ id: p.id, username, text: p.text, publishedAt: p.created_at ? new Date(p.created_at) : null, permalink: permalinkOf(username, p.id), keyword: "x:search" });
      }
      return { found, error: null };
    } catch (err) {
      return { found: [], error: `X search: ${errorMessage(err)}` };
    }
  },

  async metrics(postId: string): Promise<PostMetrics> {
    const m = (await xClient().postMetrics([postId])).get(postId);
    return { views: m?.impression_count ?? 0, likes: m?.like_count ?? 0, replies: m?.reply_count ?? 0, reposts: m?.retweet_count ?? 0, quotes: m?.quote_count ?? 0, shares: m?.bookmark_count ?? 0 };
  },

  manualReplyUrl(postId: string, text: string): string {
    return `https://x.com/intent/post?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;
  },
};
