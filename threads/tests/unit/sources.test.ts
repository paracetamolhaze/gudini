import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestPost, type IngestDeps } from "../../src/services/sources/ingest.js";
import type { NormalizedPost } from "../../src/services/sources/normalize.js";
import { normalizeThreadsMedia } from "../../src/services/sources/normalize.js";
import type { NewSourcePost, SourcePostRow } from "../../src/db/repos/sourcePosts.js";
import { parseFeed, feedItemToPost } from "../../src/services/sources/rssSource.js";
import { fetchProfilePosts, SourceAccessError } from "../../src/services/sources/threadsProfileSource.js";
import { ThreadsClient } from "../../src/threads/client.js";
import { contentHash, simhash, hammingDistance } from "../../src/services/dedup/hash.js";
import { textSimilarity } from "../../src/services/dedup/similarity.js";

/** In-memory stand-in for the source_posts table with the same uniqueness rule. */
function memoryDeps(): IngestDeps & { rows: SourcePostRow[] } {
  const rows: SourcePostRow[] = [];
  let n = 0;
  return {
    rows,
    async insert(p: NewSourcePost) {
      if (rows.some((r) => r.platform === p.platform && r.platform_post_id === p.platformPostId)) return null;
      const row: SourcePostRow = {
        id: `row-${++n}`,
        source_id: p.sourceId,
        platform: p.platform,
        platform_post_id: p.platformPostId,
        author_username: p.authorUsername,
        text: p.text,
        permalink: p.permalink,
        published_at: p.publishedAt,
        media_json: p.media,
        raw_json: p.raw,
        content_hash: p.contentHash,
        semantic_hash: p.semanticHash,
        status: "NEW",
        duplicate_of: null,
        created_at: new Date(),
      };
      rows.push(row);
      return row;
    },
    async findByContentHash(hash) {
      return rows.find((r) => r.content_hash === hash) ?? null;
    },
    async recentPosts(_hours, excludeId) {
      return rows.filter((r) => r.id !== excludeId && r.status !== "DUPLICATE");
    },
    async markDuplicate(id, dup) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "DUPLICATE";
      r.duplicate_of = dup;
    },
  };
}

const post = (id: string, text: string, author = "blogger", minutesAgo = 5): NormalizedPost => ({
  platform: "threads",
  platformPostId: id,
  authorUsername: author,
  text,
  permalink: `https://www.threads.net/@${author}/post/${id}`,
  publishedAt: new Date(Date.now() - minutesAgo * 60_000),
  media: [],
  raw: {},
});

const opts = { sourceId: "s1", windowHours: 72, similarityThreshold: 0.62, maxAgeHours: 72 };

test("Test 1: the same source post ingested twice yields one stored row", async () => {
  const deps = memoryDeps();
  const p = post("1", "Bitcoin ETFs recorded $650M net inflows yesterday, the biggest day since March.");
  const first = await ingestPost(p, opts, deps);
  const second = await ingestPost(p, opts, deps);
  assert.equal(first.kind, "inserted");
  assert.equal(second.kind, "already_stored");
  assert.equal(deps.rows.length, 1);
});

test("a verbatim copy from another author is an exact duplicate; a paraphrase is a near duplicate", async () => {
  const deps = memoryDeps();
  const original = "Bitcoin ETFs recorded $650M net inflows yesterday, the biggest day since March. IBIT led with $420M.";
  await ingestPost(post("1", original, "a"), opts, deps);
  const copy = await ingestPost(post("2", `${original} 🔥`, "b"), opts, deps);
  assert.equal(copy.kind, "duplicate");
  if (copy.kind === "duplicate") assert.equal(copy.method, "exact");
  const para = await ingestPost(post("3", "Bitcoin ETFs recorded $650M net inflows yesterday — biggest day since March, IBIT led with $420M inflows.", "c"), opts, deps);
  assert.equal(para.kind, "duplicate");
  if (para.kind === "duplicate") assert.ok(para.similarity >= 0.62, `similarity ${para.similarity}`);
  const other = await ingestPost(post("4", "Solana validators voted to raise the compute unit limit per block by 20%.", "d"), opts, deps);
  assert.equal(other.kind, "inserted");
});

test("posts older than the window are ignored", async () => {
  const deps = memoryDeps();
  const r = await ingestPost(post("old", "Ethereum Pectra upgrade went live.", "e", 5 * 24 * 60), opts, deps);
  assert.equal(r.kind, "too_old");
  assert.equal(deps.rows.length, 0);
});

test("hashes: canonical text ignores case, urls and handles; simhash is close for near-identical text", () => {
  assert.equal(contentHash("BTC hits $100K! https://x.com/a @me"), contentHash("btc hits $100k https://y.com/b"));
  const a = simhash("Bitcoin ETFs recorded $650M net inflows yesterday, the biggest day since March");
  const b = simhash("Bitcoin ETFs recorded $650M net inflows yesterday, the biggest day since March again");
  assert.ok(hammingDistance(a, b) <= 12, `distance ${hammingDistance(a, b)}`);
  assert.ok(textSimilarity("Solana outage lasted five hours", "Bitcoin ETF inflows hit a record") < 0.2);
});

test("normalizeThreadsMedia keeps quoted text and images, drops empty objects", () => {
  const p = normalizeThreadsMedia({
    id: "9",
    text: "This is huge",
    username: "someone",
    timestamp: "2026-09-14T10:00:00+0000",
    media_type: "IMAGE",
    media_url: "https://cdn.example.com/a.jpg",
    quoted_post: { id: "8", text: "ETF flows $650M", username: "news" },
  });
  assert.ok(p);
  assert.match(p!.text, /quoting @news/);
  assert.equal(p!.media.length, 1);
  assert.equal(normalizeThreadsMedia({ id: "10" }), null);
});

test("RSS and Atom feeds parse into posts with link ids and images", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Bitcoin ETF inflows top $650M</title><link>https://www.example.com/news/etf?utm_source=rss</link><description><![CDATA[<p>Spot ETFs saw <b>$650M</b>.</p>]]></description><pubDate>Mon, 14 Sep 2026 08:00:00 GMT</pubDate><media:content url="https://img.example.com/etf.jpg" /></item></channel></rss>`;
  const items = parseFeed(rss);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.link, "https://example.com/news/etf");
  assert.equal(items[0]!.imageUrl, "https://img.example.com/etf.jpg");
  const p = feedItemToPost(items[0]!, "Example");
  assert.equal(p.platform, "rss");
  assert.match(p.text, /\$650M/);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Solana hits ATH</title><link rel="alternate" href="https://blog.example.com/sol"/><updated>2026-09-14T09:00:00Z</updated><summary>Up 12%</summary></entry></feed>`;
  assert.equal(parseFeed(atom)[0]!.link, "https://blog.example.com/sol");
});

function clientWith(handler: (url: URL) => { status: number; body: unknown }): ThreadsClient {
  return new ThreadsClient({
    accessToken: "t",
    userId: "1",
    minRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
}

test("profile watcher falls back to keyword_search?author_username when profile_posts is refused", async () => {
  const client = clientWith((url) => {
    if (url.pathname.endsWith("/profile_posts")) return { status: 400, body: { error: { message: "(#10) needs threads_profile_discovery", code: 10 } } };
    if (url.pathname.endsWith("/keyword_search")) {
      assert.equal(url.searchParams.get("author_username"), "crypto_blogger");
      return { status: 200, body: { data: [{ id: "p1", text: `${url.searchParams.get("q")} news`, username: "crypto_blogger", timestamp: "2026-09-14T10:00:00+0000" }] } };
    }
    return { status: 404, body: {} };
  });
  const r = await fetchProfilePosts(client, "@crypto_blogger", { fallbackKeywords: ["bitcoin", "etf"] });
  assert.equal(r.method, "keyword_search");
  assert.equal(r.posts.length, 1);
});

test("profile watcher names both missing scopes when every official path is refused", async () => {
  const client = clientWith(() => ({ status: 400, body: { error: { message: "(#10) Permission denied", code: 10 } } }));
  await assert.rejects(
    () => fetchProfilePosts(client, "x", { fallbackKeywords: ["bitcoin"] }),
    (err: unknown) => err instanceof SourceAccessError && err.scopes.includes("threads_profile_discovery") && err.scopes.includes("threads_keyword_search"),
  );
});
