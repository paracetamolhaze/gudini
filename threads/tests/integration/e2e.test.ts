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
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const schema = req.jsonSchema?.name ?? "text";
    this.calls.push(schema);
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
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const p = url.pathname.replace(/^\/v1\.0/, "");
    calls.push(`${method} ${p}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (p === "/me") return json({ id: "777", username: "ru_crypto" });
    if (method === "POST" && p === "/777/threads") {
      const text = String((init?.body as URLSearchParams).get("text") ?? "");
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
  return { fetchImpl, posts, replies, calls };
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
  await getPool().query(`TRUNCATE sources, source_posts, event_clusters, content_candidates, drafts, media_assets, publication_attempts, publications, interactions, conversation_messages, discovered_posts, style_examples, draft_feedback, prompt_versions, jobs, audit_logs, llm_calls, insight_snapshots, recommendations, settings, accounts RESTART IDENTITY CASCADE`);
  wireLlm();
  llm().registerProvider("fake", scripted);
  await saveSettings({ mode: "REVIEW", dryRun: false, killSwitch: false, models: { analysis: "fake:m", writer: "fake:m", reply: "fake:m", vision: "fake:m", translation: "fake:m", embedding: "" } });
  setThreadsClientForTests(new ThreadsClient({ accessToken: "test-token", userId: "777", minRequestIntervalMs: 0, maxRetries: 0, fetchImpl: fake.fetchImpl }));
  setMarketDataForTests({ name: "fake", async getQuote() { return { symbol: "BTC", name: "Bitcoin", priceUsd: 101_900, change24hPct: 2.1, change7dPct: 4, marketCapUsd: 2e12, volume24hUsd: 4e10, fetchedAt: new Date(), provider: "fake" }; } });
  await query(`INSERT INTO accounts (platform, username, threads_user_id) VALUES ('threads','ru_crypto','777')`);
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
  const publication = await one<{ threads_post_id: string; permalink: string; dry_run: boolean }>(`SELECT threads_post_id, permalink, dry_run FROM publications`);
  assert.equal(publication!.threads_post_id, fake.posts[0]!.id);
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
