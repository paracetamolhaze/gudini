/**
 * End-to-end: foreign blogger post → candidate → facts → verification → Russian post → draft →
 * approval → fake Threads publisher. Runs against the real Postgres/Redis from .env.test with the
 * LLM, Threads API and market data replaced by scripted fakes. Refuses to run outside NODE_ENV=test.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envFile = path.resolve(here, "../../.env.test");
  if (!existsSync(envFile)) throw new Error("tests/integration need DATABASE_URL/REDIS_URL or threads/.env.test");
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}
process.env.NODE_ENV = "test";
process.env.THREADS_ACCESS_TOKEN = "test-token";
process.env.THREADS_USER_ID = "777";
process.env.LLM_PROVIDER = "openrouter";
process.env.PUBLIC_BASE_URL = "https://example.test";

const { env, setEnvForTests, loadEnv } = await import("../../src/config/env.js");
setEnvForTests(loadEnv(process.env));
if (env().NODE_ENV !== "test") throw new Error("refusing to run the e2e test outside NODE_ENV=test");

const { runMigrations } = await import("../../src/db/migrate.js");
const { getPool, closePool, query, one } = await import("../../src/db/pool.js");
const { closeQueues } = await import("../../src/queue/queues.js");
const { closeRedis } = await import("../../src/queue/connection.js");
const { llm } = await import("../../src/llm/index.js");
const { wireLlm } = await import("../../src/services/llmWiring.js");
const { saveSettings, loadSettings } = await import("../../src/config/settings.js");
const { ThreadsClient } = await import("../../src/threads/client.js");
const { setThreadsClientForTests } = await import("../../src/threads/index.js");
const { setMarketDataForTests } = await import("../../src/services/facts/marketData/coingecko.js");
const { insertSource } = await import("../../src/db/repos/sources.js");
const { insertSourcePost, findByContentHash, recentSourcePosts, setSourcePostStatus } = await import("../../src/db/repos/sourcePosts.js");
const { ingestPost } = await import("../../src/services/sources/ingest.js");
const { analyzeSourcePostById } = await import("../../src/services/analysis/pipeline.js");
const { generateDraftForCandidate } = await import("../../src/services/writer/pipeline.js");
const { publishDraft } = await import("../../src/services/publishing/pipeline.js");
const { getCandidate } = await import("../../src/db/repos/candidates.js");
const { getDraft, transitionDraft } = await import("../../src/db/repos/drafts.js");
const { pollReplies } = await import("../../src/services/replies/pipeline.js");

import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/llm/provider.js";
import type { NormalizedPost } from "../../src/services/sources/normalize.js";

const ANALYSIS = {
  language: "en",
  topic: "Рекордный приток в биткоин-ETF",
  category: "bitcoin",
  summary: "Спотовые биткоин-ETF в США за день привлекли $650 млн, крупнейший приток с марта. Лидер — IBIT от BlackRock с $420 млн.",
  eventKey: "btc-etf-inflows-2026-09-13",
  entities: ["Bitcoin", "BTC", "IBIT", "BlackRock", "spot ETF"],
  facts: [
    { claim: "Bitcoin ETFs recorded $650M net inflows yesterday", type: "number", certainty: "FACT", confidence: 0.95, requiresVerification: true, isDynamic: false, asset: null, value: 650_000_000, unit: "USD" },
    { claim: "IBIT took $420M of the inflows", type: "number", certainty: "FACT", confidence: 0.9, requiresVerification: true, isDynamic: false, asset: null, value: 420_000_000, unit: "USD" },
    { claim: "BTC trades at $101,500", type: "price", certainty: "FACT", confidence: 0.9, requiresVerification: true, isDynamic: true, asset: "BTC", value: 101_500, unit: "USD" },
  ],
  relevanceScore: 92,
  freshnessScore: 95,
  noveltyScore: 70,
  valueScore: 85,
  riskScore: 12,
  isBreaking: false,
  contentKind: "NEWS",
  worthPosting: true,
  reason: "крупное рыночное событие с проверяемыми цифрами",
  suggestedAngle: "институциональный спрос возвращается",
  injectionAttempt: false,
};

const WRITER = {
  variants: [
    {
      type: "NEWS",
      hook: "Институционалы вернулись: за день спотовые биткоин-ETF привлекли $650 млн по данным @crypto_blogger.",
      body: "Крупнейший приток с марта. Лидер — IBIT от BlackRock с $420 млн. Биткоин при этом держится около $101 500.",
      usedFacts: [0, 1, 2],
      hedgedFacts: [0, 1],
      confidence: 90,
      selfCheck: "650M, 420M, 101500",
    },
    { type: "SHORT", hook: "Биткоин-ETF за день собрали $650 млн — как пишет @crypto_blogger, это максимум с марта.", body: "", usedFacts: [0], hedgedFacts: [0], confidence: 85, selfCheck: "650M" },
  ],
};

class ScriptedLlm implements LlmProvider {
  readonly name = "fake";
  calls: string[] = [];
  /** Schema name the provider should refuse, to play a provider outage. */
  fail: string | null = null;
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const schema = req.jsonSchema?.name ?? "text";
    this.calls.push(schema);
    if (this.fail && schema === this.fail) throw new Error("openrouter: HTTP 403 — Key limit exceeded (total limit)");
    let answer: unknown;
    switch (schema) {
      case "SourceAnalysis":
        answer = ANALYSIS;
        break;
      case "WriterOutput":
        answer = WRITER;
        break;
      case "ReplyDecision":
        answer = { action: "REPLY", reason: "вопрос про источник", sentiment: "neutral", toxicityScore: 3, confidence: 90 };
        break;
      case "ReplyText":
        answer = { text: "Farside считает только американские спотовые ETF, $650 млн — сумма по всем эмитентам за день.", askedQuestion: false, confidence: 88 };
        break;
      case "ReplyReview":
        answer = { cryptoRelevant: true, addsValue: true, grounded: true, safe: true, reason: "Полезное пояснение механизма" };
        break;
      case "TradePost":
        answer = { text: "Закрыл лонг по BTC: вход 60 500, выход 62 600, плечо x10. Вышло +34.1% на маржу за пару часов. Забрал своё и не стал пересиживать.", xText: "Закрыл лонг BTC: 60 500 → 62 600, x10, +34.1% на маржу. Забрал своё.", confidence: 90 };
        break;
      case "MoverPost":
        answer = { text: "SOL за сутки +18.4%, цена уже $212.4. Явной причины пока не вижу — просто смотрю, как рынок переваривает движение, и не лезу в догонку.", xText: "SOL +18.4% за сутки, уже $212.4. Причины не вижу, в догонку не лезу.", confidence: 88 };
        break;
      case "TopicPost":
        answer = { text: "Рост активности сети не гарантирует рост токена. Важно, кто платит комиссии и получает ли токен часть этой ценности. Число транзакций без такой связи мало говорит об инвестиционном спросе.", cryptoRelevant: true };
        break;
      default:
        throw new Error(`unexpected LLM call: ${schema}`);
    }
    return { text: JSON.stringify(answer), usage: { inputTokens: 100, outputTokens: 50 }, model: req.model, provider: "fake" };
  }
  async test() {
    return { ok: true, message: "fake" };
  }
}

/** Minimal Threads Graph API in memory: /me, containers, publish, own posts, replies inbox, conversation. */
function fakeThreads() {
  const posts: Array<{ id: string; text: string; permalink: string }> = [];
  const replies: Array<{ id: string; text: string; username: string; root: string; parent: string; timestamp: string }> = [];
  let n = 0;
  const calls: string[] = [];
  const images: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const p = url.pathname.replace(/^\/v1\.0/, "");
    calls.push(`${method} ${p}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (p === "/me") return json({ id: "777", username: "ru_crypto" });
    if (method === "POST" && p === "/777/threads") {
      const text = String((init?.body as URLSearchParams).get("text") ?? "");
      const imageUrl = (init?.body as URLSearchParams).get("image_url");
      if (imageUrl) images.push(imageUrl);
      const id = `c${++n}`;
      (posts as unknown as Record<string, unknown>)[`pending:${id}`] = text;
      return json({ id });
    }
    if (method === "GET" && /^\/c\d+$/.test(p)) return json({ status: "FINISHED" });
    if (method === "POST" && p === "/777/threads_publish") {
      const cid = String((init?.body as URLSearchParams).get("creation_id"));
      const text = String((posts as unknown as Record<string, unknown>)[`pending:${cid}`] ?? "");
      const id = `post${++n}`;
      posts.push({ id, text, permalink: `https://www.threads.net/@ru_crypto/post/${id}` });
      return json({ id });
    }
    if (method === "GET" && /^\/post\d+$/.test(p)) {
      const post = posts.find((x) => x.id === p.slice(1));
      return post ? json({ id: post.id, permalink: post.permalink, text: post.text }) : json({ error: { message: "not found", code: 100 } }, 400);
    }
    if (method === "GET" && p === "/777/threads") return json({ data: posts.map((x) => ({ id: x.id, text: x.text, permalink: x.permalink, timestamp: new Date().toISOString() })) });
    if (method === "GET" && p === "/777/replies") return json({ data: replies.map((r) => ({ id: r.id, text: r.text, username: r.username, timestamp: r.timestamp, replied_to: { id: r.parent }, root_post: { id: r.root } })) });
    if (method === "GET" && p === "/777/mentions") return json({ error: { message: "(#10) needs threads_manage_mentions", code: 10 } }, 400);
    if (method === "GET" && /\/conversation$/.test(p)) {
      const root = p.split("/")[1]!;
      return json({ data: replies.filter((r) => r.root === root).map((r) => ({ id: r.id, text: r.text, username: r.username, timestamp: r.timestamp, replied_to: { id: r.parent } })) });
    }
    return json({ error: { message: `unhandled ${method} ${p}`, code: 100 } }, 400);
  }) as typeof fetch;
  return { fetchImpl, posts, replies, calls, images };
}

const post = (id: string, author: string, text: string): NormalizedPost => ({
  platform: "threads",
  platformPostId: id,
  authorUsername: author,
  text,
  permalink: `https://www.threads.net/@${author}/post/${id}`,
  publishedAt: new Date(Date.now() - 20 * 60_000),
  media: [],
  raw: {},
});

const dbDeps = { insert: insertSourcePost, findByContentHash: (h: string) => findByContentHash(h), recentPosts: (hours: number, ex: string) => recentSourcePosts(hours, ex), markDuplicate: (id: string, dup: string) => setSourcePostStatus(id, "DUPLICATE", dup) };

const fake = fakeThreads();
const scripted = new ScriptedLlm();

before(async () => {
  await runMigrations();
  await getPool().query(`TRUNCATE sources, source_posts, event_clusters, content_candidates, drafts, media_assets, publication_attempts, publications, interactions, conversation_messages, discovered_posts, style_examples, draft_feedback, prompt_versions, jobs, audit_logs, llm_calls, insight_snapshots, recommendations, settings, accounts, platform_usage, hl_fills, hl_trades, hl_leverage, market_moves RESTART IDENTITY CASCADE`);
  wireLlm();
  llm().registerProvider("fake", scripted);
  await saveSettings({ mode: "REVIEW", dryRun: false, killSwitch: false, models: { analysis: "fake:m", writer: "fake:m", reply: "fake:m", vision: "fake:m", translation: "fake:m", embedding: "" } });
  setThreadsClientForTests(new ThreadsClient({ accessToken: "test-token", userId: "777", minRequestIntervalMs: 0, maxRetries: 0, fetchImpl: fake.fetchImpl }));
  setMarketDataForTests({ name: "fake", async getQuote() { return { symbol: "BTC", name: "Bitcoin", priceUsd: 101_900, change24hPct: 2.1, change7dPct: 4, marketCapUsd: 2e12, volume24hUsd: 4e10, fetchedAt: new Date(), provider: "fake" }; } });
  await query(`INSERT INTO accounts (platform, username, platform_user_id) VALUES ('threads','ru_crypto','777')`);
});

after(async () => {
  await closeQueues();
  await closeRedis();
  await closePool();
});

test("E2E: foreign blogger post → candidate → facts → Russian draft → approval → published via fake Threads", async () => {
  const source = await insertSource({ type: "THREADS_PROFILE", username: "crypto_blogger", priority: 1, trust_score: 80 });
  const opts = { sourceId: source.id, windowHours: 72, similarityThreshold: 0.62, maxAgeHours: 72 };

  // 1. ingestion — the same post twice is stored once (Test 1)
  const original = post("p1", "crypto_blogger", "Bitcoin ETFs recorded $650M net inflows yesterday, the biggest day since March. IBIT took $420M. BTC trades at $101,500.");
  const first = await ingestPost(original, opts, dbDeps);
  assert.equal(first.kind, "inserted");
  const again = await ingestPost(original, opts, dbDeps);
  assert.equal(again.kind, "already_stored");
  if (first.kind !== "inserted") return;

  // 2. analysis → cluster → score → fact check → candidate approved for generation
  const analyzed = await analyzeSourcePostById(first.row.id);
  assert.equal(analyzed.kind, "approved", JSON.stringify(analyzed));
  if (analyzed.kind !== "approved") return;
  const candidate = await getCandidate(analyzed.candidateId);
  assert.ok(candidate);
  assert.equal(candidate!.status, "APPROVED_FOR_GENERATION");
  assert.equal(candidate!.category, "bitcoin");
  const facts = candidate!.facts_json!.facts;
  assert.equal(facts.find((f) => f.asset === "BTC")!.status, "VERIFIED", "price verified against the market provider");
  assert.equal(facts.find((f) => f.value === 650_000_000)!.status, "UNVERIFIED", "ETF flows have no independent source → attribution required");

  // 3. a second author on the same event joins the cluster instead of creating a new candidate (Test 2)
  const second = await ingestPost(post("p2", "other_blogger", "Huge day for spot ETFs: $650M net inflows, IBIT alone pulled $420M. Institutions are back."), opts, dbDeps);
  assert.equal(second.kind, "inserted");
  if (second.kind !== "inserted") return;
  const merged = await analyzeSourcePostById(second.row.id);
  assert.equal(merged.kind, "merged", JSON.stringify(merged));
  const candidates = await query(`SELECT id FROM content_candidates`);
  assert.equal(candidates.length, 1, "one event → one candidate");

  // 4. writer → draft with validated numbers
  const gen = await generateDraftForCandidate(candidate!.id);
  assert.equal(gen.kind, "draft", JSON.stringify(gen));
  if (gen.kind !== "draft") return;
  const draft = await getDraft(gen.draftId);
  assert.ok(draft);
  assert.equal(draft!.status, "DRAFT", draft!.review_reason ?? "");
  assert.match(draft!.text, /\$650 млн/);
  assert.match(draft!.text, /@crypto_blogger/);

  // 5. nothing publishes on its own in REVIEW mode (Test 4)
  const held = await publishDraft(draft!.id, { manual: false });
  assert.equal(held.kind, "skipped");
  assert.equal(fake.posts.length, 0);

  // 6. human approves and publishes → fake Threads receives exactly one post
  await transitionDraft(draft!.id, ["DRAFT"], "APPROVED");
  const published = await publishDraft(draft!.id, { manual: true });
  assert.equal(published.kind, "published", JSON.stringify(published));
  assert.equal(fake.posts.length, 1);
  assert.equal(fake.posts[0]!.text, draft!.text);
  const publication = await one<{ platform: string; platform_post_id: string; permalink: string; dry_run: boolean }>(`SELECT platform, platform_post_id, permalink, dry_run FROM publications`);
  assert.equal(publication!.platform_post_id, fake.posts[0]!.id);
  assert.equal(publication!.platform, "threads", "X is not connected, so the draft only targeted Threads");
  assert.equal(publication!.dry_run, false);
  assert.equal((await getDraft(draft!.id))!.status, "PUBLISHED");
  assert.equal((await getCandidate(candidate!.id))!.status, "PUBLISHED");

  // 7. a comment under the post reaches Replies with a proposed answer (manual send in REVIEW mode)
  fake.replies.push({ id: "r1", text: "А откуда цифра $650 млн? Это только американские ETF?", username: "reader", root: fake.posts[0]!.id, parent: fake.posts[0]!.id, timestamp: new Date().toISOString() });
  const polled = await pollReplies();
  assert.equal(polled.found, 1);
  const interaction = await one<{ status: string; our_text: string; decision: string; type: string }>(`SELECT status, our_text, decision, type FROM interactions`);
  assert.equal(interaction!.type, "OWN_POST_REPLY");
  assert.equal(interaction!.decision, "REPLY");
  assert.equal(interaction!.status, "DRAFT", "REVIEW mode keeps the reply for a human");
  assert.match(interaction!.our_text, /Farside/);

  // 8. every step left a trail in the audit log and the cost ledger
  const events = (await query<{ event: string }>(`SELECT event FROM audit_logs`)).map((r) => r.event);
  for (const e of ["CANDIDATE_ANALYZED", "FACT_CHECKED", "EVENT_CLUSTERED", "POST_GENERATED", "POST_PUBLISHED", "REPLY_FOUND", "REPLY_GENERATED"]) assert.ok(events.includes(e), `audit has ${e}`);
  const calls = await one<{ n: number; cost: number | null }>(`SELECT count(*)::int AS n, sum(estimated_cost)::float AS cost FROM llm_calls`);
  assert.ok(calls!.n >= 4);
  const settings = await loadSettings(true);
  assert.equal(settings.mode, "REVIEW");
});

test("simple composer writes a topic draft and own reply filtering works", async () => {
  const { insertDraft } = await import("../../src/db/repos/drafts.js");
  const { writeTopic } = await import("../../src/services/writer/topic.js");
  const { listInteractions } = await import("../../src/db/repos/interactions.js");
  const draft = await insertDraft({ candidateId: null, type: "EXPLAINER", text: "", hook: null, body: null, sourceSummary: "Активность сети и цена токена", sourceUrls: [], confidence: null, riskScore: null, status: "GENERATING", reviewReason: null, priority: "P2", promptVersion: "topic_v1", model: null, validation: null, variants: [], expiresAt: null });
  await writeTopic(draft.id);
  assert.equal((await getDraft(draft.id))?.status, "DRAFT");
  assert.match((await getDraft(draft.id))!.text, /комиссии/);
  const own = await listInteractions({ type: "own" });
  assert.ok(own.length > 0, "own is a group, not a nonexistent database type");
  assert.ok(own.every(r => r.type !== "PUBLIC_POST_REPLY"));
});

test("automatic sends recheck flags, serialize queues and respect cooldowns", async () => {
  const { insertInteraction, updateInteraction, getInteraction } = await import("../../src/db/repos/interactions.js");
  const { sendInteraction } = await import("../../src/services/replies/pipeline.js");
  const make = async (name: string, text: string) => {
    const row = await insertInteraction({ type: "PUBLIC_POST_REPLY", targetPostId: name, targetReplyId: null, rootPostId: name, publicationId: null, targetUsername: name, targetText: "Как спрос на блокспейс связан с ценой криптовалюты?", targetPermalink: null, targetPublishedAt: new Date() });
    await updateInteraction(row!.id, { our_text: text, status: "APPROVED" });
    return row!.id;
  };
  const a = await make("public-a", "Рост комиссий отражает спрос на блокспейс, но не гарантирует роста цены токена.");
  const b = await make("public-b", "Ликвидность пула определяет проскальзывание при обмене. Объём торгов сам по себе глубину не показывает.");
  await saveSettings({ mode: "AUTO", dryRun: false, flags: { autoPublicReplies: false } });
  assert.equal(await sendInteraction(a, { manual: false }), "skipped");
  assert.equal((await getInteraction(a))?.status, "APPROVED");
  await saveSettings({ flags: { autoPublicReplies: true } });
  const outcomes = await Promise.all([sendInteraction(a, { manual: false }), sendInteraction(b, { manual: false })]);
  assert.equal(outcomes.filter(x => x === "sent").length, 1, "account lock prevents simultaneous cross-queue sends");
  const waiting = (await getInteraction(a))?.status === "SENT" ? b : a;
  assert.equal(await sendInteraction(waiting, { manual: false }), "skipped", "second reply waits for cooldown");
  assert.match((await getInteraction(waiting))!.reason!, /Пауза/);
  await saveSettings({ killSwitch: true });
  assert.equal(await sendInteraction(waiting, { manual: true }), "skipped", "pause blocks manual sends too");
  await saveSettings({ killSwitch: false, dryRun: true });
  assert.equal(await sendInteraction(waiting, { manual: true }), "skipped");
  assert.equal((await getInteraction(waiting))?.status, "DRAFT", "dry run is never marked SENT");
});

test("a user-scheduled topic publishes with automatic news publishing disabled", async () => {
  const { updateDraft } = await import("../../src/db/repos/drafts.js");
  const { publisherTick } = await import("../../src/services/publishing/pipeline.js");
  await saveSettings({ mode: "REVIEW", killSwitch: false, dryRun: false, flags: { autoPost: false }, schedule: { preferredHours: Array.from({length:24}, (_,i)=>i), minimumMinutesBetweenPosts: 1 } });
  await query("UPDATE publications SET published_at = now() - interval '2 hours'");
  const topic = await one<{id:string}>("SELECT id FROM drafts WHERE candidate_id IS NULL AND status = 'DRAFT' LIMIT 1");
  assert.ok(topic);
  await updateDraft(topic.id, { status: "SCHEDULED", scheduled_at: new Date(Date.now()-1000), approved_by_user: true });
  const outcome = await publisherTick();
  assert.equal(outcome.published, 1, JSON.stringify(outcome));
  assert.equal((await getDraft(topic.id))?.status, "PUBLISHED");
});

test("Hyperliquid: fills become trades; a fresh winner gets a card and a post, a loser never does", async () => {
  const { HyperliquidClient, setHyperliquidForTests } = await import("../../src/hyperliquid/client.js");
  const { syncTrades } = await import("../../src/services/trades/pipeline.js");
  const wallet = `0x${"ab12".repeat(10)}`;
  const now = Date.now();
  const h = 3_600_000;
  const base = { dir: "", hash: "0xabc", oid: 1, crossed: true, feeToken: "USDC" };
  const fills = [
    { ...base, coin: "BTC", px: "60000", sz: "0.5", side: "B", time: now - 4 * h, startPosition: "0", closedPnl: "0", fee: "9", tid: 101 },
    { ...base, coin: "BTC", px: "61000", sz: "0.5", side: "B", time: now - 3.5 * h, startPosition: "0.5", closedPnl: "0", fee: "9", tid: 102 },
    { ...base, coin: "BTC", px: "62000", sz: "0.4", side: "A", time: now - 2 * h, startPosition: "1", closedPnl: "600", fee: "7", tid: 103 },
    { ...base, coin: "BTC", px: "63000", sz: "0.6", side: "A", time: now - 1 * h, startPosition: "0.6", closedPnl: "1500", fee: "11", tid: 104 },
    { ...base, coin: "ETH", px: "3000", sz: "1", side: "A", time: now - 3 * h, startPosition: "0", closedPnl: "0", fee: "1", tid: 201 },
    { ...base, coin: "ETH", px: "3100", sz: "1", side: "B", time: now - 2.5 * h, startPosition: "-1", closedPnl: "-100", fee: "1", tid: 202 },
    { ...base, coin: "@107", px: "1", sz: "10", side: "B", time: now - 2 * h, startPosition: "0", closedPnl: "0", fee: "0.1", tid: 301 },
  ];
  const asked: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number };
    asked.push(body.type);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (body.type === "userFillsByTime") return json(fills.filter((f) => f.time >= (body.startTime ?? 0)));
    if (body.type === "clearinghouseState") return json({ assetPositions: [] });
    if (body.type === "activeAssetData") return json({ leverage: { type: "cross", value: 10 } });
    if (body.type === "candleSnapshot") return json(Array.from({ length: 40 }, (_, i) => ({ t: now - 5 * h + i * 450_000, T: 0, o: "0", c: String(60_000 + i * 80), h: "0", l: "0", v: "0" })));
    return json({});
  }) as typeof fetch;
  setHyperliquidForTests(new HyperliquidClient({ fetchImpl }));
  await saveSettings({ mode: "REVIEW", killSwitch: false, dryRun: false, trades: { enabled: true, wallet, handle: "ru_crypto" } });

  const first = await syncTrades();
  assert.deepEqual([first.error, first.newFills, first.closedNow, first.drafted], [null, 6, 2, 1], JSON.stringify(first));
  const btc = await one<{ status: string; direction: string; net_pnl: string; leverage: string; roe_pct: string; post_status: string; draft_id: string; card_asset_id: string }>("SELECT * FROM hl_trades WHERE coin = $1", ["BTC"]);
  assert.deepEqual([btc!.status, btc!.direction, Number(btc!.net_pnl), Number(btc!.leverage), Number(btc!.roe_pct), btc!.post_status], ["CLOSED", "LONG", 2064, 10, 34.12, "DRAFTED"]);
  const eth = await one<{ post_status: string; skip_reason: string; net_pnl: string }>("SELECT post_status, skip_reason, net_pnl FROM hl_trades WHERE coin = $1", ["ETH"]);
  assert.deepEqual([eth!.post_status, Number(eth!.net_pnl)], ["SKIPPED", -102]);
  assert.match(eth!.skip_reason, /не в плюсе/);
  assert.equal((await query("SELECT 1 FROM hl_fills WHERE coin = $1", ["@107"])).length, 0, "spot fills are not perp trades");

  const draft = await getDraft(btc!.draft_id);
  assert.deepEqual([draft!.kind, draft!.status, draft!.platforms, draft!.image_asset_id], ["TRADE", "DRAFT", ["threads"], btc!.card_asset_id], draft!.review_reason ?? "");
  assert.match(draft!.text, /\+34\.1%/);
  // Every number the writer may use: the trade itself plus the market context read off the same candles.
  const claims = draft!.facts_json!.facts.map((f) => f.claim).join(" | ");
  for (const needle of ["Entry price", "Exit price", "Return on margin", "Leverage used", "Net PnL"]) assert.match(claims, new RegExp(needle), claims);
  assert.ok(draft!.facts_json!.facts.length > 6, `market context must reach the writer: ${claims}`);
  assert.ok(draft!.facts_json!.facts.every((f) => f.status === "VERIFIED" && typeof f.value === "number"), claims);
  const asset = await one<{ status: string; final_path: string; width: number }>("SELECT status, final_path, width FROM media_assets WHERE id = $1", [btc!.card_asset_id]);
  assert.deepEqual([asset!.status, asset!.width, existsSync(asset!.final_path)], ["QA_PASSED", 1440, true]);

  // the same fills again change nothing
  const again = await syncTrades();
  assert.deepEqual([again.newFills, again.drafted], [0, 0]);
  assert.equal((await query("SELECT 1 FROM drafts WHERE kind = $1", ["TRADE"])).length, 1);

  // published with the card; the trade is marked as posted.
  // Одобряем так же, как это делает кнопка на сайте: публиковать разрешено только одобренный
  // черновик — иначе пост, возвращённый владельцем в черновики, ушёл бы из уже стоящей задачи.
  await query("UPDATE publications SET published_at = now() - make_interval(hours => 3)");
  await transitionDraft(draft!.id, ["DRAFT", "NEEDS_REVIEW"], "APPROVED");
  const out = await publishDraft(draft!.id, { manual: true });
  assert.equal(out.kind, "published", JSON.stringify(out));
  assert.equal(fake.images.at(-1), `https://example.test/threads/media/public/${btc!.card_asset_id}/final.jpg`);
  assert.equal((await one<{ post_status: string }>("SELECT post_status FROM hl_trades WHERE coin = $1", ["BTC"]))!.post_status, "POSTED");
  assert.ok(asked.includes("activeAssetData") && asked.includes("candleSnapshot"));
  setHyperliquidForTests(null);
});

test("a loud market move becomes a draft built only from verified numbers", async () => {
  const { createMoverDraft, getMove } = await import("../../src/services/market/movers.js");
  const move = await one<{ id: string }>(
    "INSERT INTO market_moves (symbol, name, coingecko_id, direction, period, change_pct, price, market_cap, volume_24h, rank, day) VALUES ($1,$2,$3,$4,$5,18.44,212.4,1e11,9.1e9,5,current_date) RETURNING id",
    ["SOL", "Solana", "solana", "UP", "24h"],
  );
  const created = await createMoverDraft(move!.id);
  const draft = await getDraft(created.draftId);
  assert.deepEqual([draft!.kind, draft!.status, draft!.type], ["MOVER", "DRAFT", "MOVER"], draft!.review_reason ?? "");
  assert.ok(draft!.expires_at && draft!.expires_at.getTime() - Date.now() < 9 * 3_600_000, "a market move goes stale within hours");
  assert.equal((await getMove(move!.id))!.status, "DRAFTED");
  assert.deepEqual((await createMoverDraft(move!.id)).draftId, created.draftId, "asking twice returns the same draft");
});

test("one post, two platforms: X fails → PARTIAL, and a retry only sends what is still missing", async () => {
  const { setPlatformForTests } = await import("../../src/platforms/index.js");
  const { insertDraft } = await import("../../src/db/repos/drafts.js");
  const { postsPublishedLast24h } = await import("../../src/db/repos/publishing.js");
  const sent: Array<[string, string]> = [];
  let failX = true;
  setPlatformForTests("x", {
    id: "x",
    label: "X",
    maxChars: () => 280,
    publicReplyChannel: () => "manual_or_quote",
    configured: () => true,
    async me() {
      return { id: "42", username: "me_x" };
    },
    async publishPost(req) {
      if (failX) throw new Error("X API 503: over capacity");
      sent.push([req.key, req.text]);
      return { id: `x${sent.length}`, permalink: `https://x.com/me_x/status/x${sent.length}`, parts: 1, recovered: false };
    },
    async publishReply() {
      throw new Error("not used");
    },
    async fetchInbox() {
      return { items: [], conversations: new Map(), notice: null };
    },
    async searchPosts() {
      return { found: [], error: null };
    },
    async metrics() {
      return { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
    },
  });
  await saveSettings({ mode: "REVIEW", killSwitch: false, dryRun: false });
  const threadsBefore = fake.posts.length;
  const countBefore = await postsPublishedLast24h();
  const xText = "Фандинг — плата за перекос толпы. Держишь перп долго — он тихо ест результат.";
  const draft = await insertDraft({ candidateId: null, kind: "TOPIC", platforms: ["threads", "x"], type: "EXPLAINER", text: "Фандинг на бессрочных контрактах — это плата за перекос толпы. Держишь позицию долго против перекоса — она тихо съедает результат.", textX: xText, hook: null, body: null, sourceSummary: "фандинг", sourceUrls: [], confidence: 90, riskScore: 5, status: "APPROVED", reviewReason: null, priority: "P2", promptVersion: "t", model: null, validation: null, variants: [], expiresAt: null });

  const first = await publishDraft(draft.id, { manual: true });
  assert.equal(first.kind, "published", JSON.stringify(first));
  if (first.kind !== "published") return;
  assert.deepEqual([first.partial, first.platforms.map((p) => `${p.platform}:${p.status}`)], [true, ["threads:published", "x:failed"]]);
  const partial = await getDraft(draft.id);
  assert.equal(partial!.status, "PARTIAL");
  assert.match(partial!.error!, /X: X API 503/);
  assert.equal(fake.posts.length, threadsBefore + 1);

  failX = false;
  const second = await publishDraft(draft.id, { manual: true });
  assert.equal(second.kind, "published", JSON.stringify(second));
  if (second.kind !== "published") return;
  assert.deepEqual(second.platforms.map((p) => `${p.platform}:${p.status}`), ["threads:already", "x:published"]);
  assert.equal(fake.posts.length, threadsBefore + 1, "Threads is never posted twice");
  assert.deepEqual(sent, [[`draft:${draft.id}:x`, xText]]);
  const done = await getDraft(draft.id);
  assert.deepEqual([done!.status, done!.error], ["PUBLISHED", null]);
  const rows = await query<{ platform: string }>("SELECT platform FROM publications WHERE draft_id = $1 ORDER BY platform", [draft.id]);
  assert.deepEqual(rows.map((r) => r.platform), ["threads", "x"]);
  assert.equal(await postsPublishedLast24h(), countBefore + 1, "a cross-post counts once against the daily cap");
  setPlatformForTests("x", null);
});

test("a move whose post could not be written is not lost: the next scan writes it", async () => {
  const { scanMovers } = await import("../../src/services/market/movers.js");
  const { HyperliquidClient, setHyperliquidForTests } = await import("../../src/hyperliquid/client.js");
  await query("DELETE FROM market_moves");
  await query("DELETE FROM drafts WHERE kind = 'MOVER'");
  setHyperliquidForTests(new HyperliquidClient({ fetchImpl: (async () => new Response("[]", { status: 200 })) as typeof fetch }));
  await saveSettings({ mode: "REVIEW", killSwitch: false, movers: { enabled: true, maxPostsPerDay: 2, minChange24hPct: 15, minChange1hPct: 8, minVolumeUsd: 20_000_000 } });
  const coins = [
    { id: "aster", symbol: "aster", name: "Aster", current_price: 2.5, market_cap: 4e8, market_cap_rank: 120, total_volume: 5e8, price_change_percentage_1h_in_currency: 1, price_change_percentage_24h_in_currency: 31.2 },
    { id: "tether", symbol: "usdt", name: "Tether", current_price: 1, market_cap: 1e11, market_cap_rank: 3, total_volume: 9e10, price_change_percentage_1h_in_currency: 0, price_change_percentage_24h_in_currency: 40 },
  ];
  const fetchImpl = (async () => new Response(JSON.stringify(coins), { status: 200 })) as typeof fetch;

  // The writer is down (this is exactly what a spent OpenRouter key looks like).
  scripted.fail = "MoverPost";
  const failed = await scanMovers({ fetchImpl });
  assert.deepEqual([failed.found, failed.drafted], [1, 0], JSON.stringify(failed));
  assert.match(failed.error ?? "", /key limit/i);
  const held = await one<{ status: string; draft_id: string | null; reason: string }>("SELECT status, draft_id, reason FROM market_moves WHERE symbol = $1", ["ASTER"]);
  assert.deepEqual([held!.status, held!.draft_id], ["FOUND", null], "the move stays on the list, ready for another try");
  assert.match(held!.reason, /пост не написан/);
  assert.equal((await query("SELECT 1 FROM market_moves WHERE symbol = $1", ["USDT"])).length, 0, "stablecoins are never a market move");

  // Writer is back: the same move is picked up again without being found again.
  scripted.fail = null;
  const retried = await scanMovers({ fetchImpl });
  assert.deepEqual([retried.found, retried.drafted, retried.error], [0, 1, null], JSON.stringify(retried));
  const done = await one<{ status: string; draft_id: string }>("SELECT status, draft_id FROM market_moves WHERE symbol = $1", ["ASTER"]);
  assert.equal(done!.status, "DRAFTED");
  assert.equal((await getDraft(done!.draft_id))!.kind, "MOVER");

  // A third scan neither duplicates the move nor the post.
  const third = await scanMovers({ fetchImpl });
  assert.deepEqual([third.found, third.drafted], [0, 0], JSON.stringify(third));
  assert.equal((await query("SELECT 1 FROM drafts WHERE kind = 'MOVER'")).length, 1);
  setHyperliquidForTests(null);
});
