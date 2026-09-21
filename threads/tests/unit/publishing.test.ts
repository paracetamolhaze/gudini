import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublish } from "../../src/services/publishing/gate.js";
import { decideSlot, hourInZone } from "../../src/services/publishing/schedule.js";
import { recheckDynamicFacts } from "../../src/services/publishing/freshness.js";
import { ThreadsPublisher, type AttemptRecord, type AttemptStore } from "../../src/threads/publisher.js";
import { ThreadsClient } from "../../src/threads/client.js";
import type { VerifiedFact } from "../../src/services/analysis/schemas.js";
import type { MarketDataProvider } from "../../src/services/facts/marketData/provider.js";

const thresholds = { maxRisk: 30, minConfidence: 85, minScore: 75 };
const clean = { status: "DRAFT", riskScore: 12, confidence: 92, totalScore: 84, expiresAt: new Date(Date.now() + 3_600_000), reviewReason: null };

test("Test 4: nothing auto-publishes unless mode is AUTO and the flag is on; kill switch blocks even manual sends", () => {
  assert.equal(decidePublish({ mode: "DRAFT", killSwitch: false, autoPostEnabled: true, manual: false, draft: clean, thresholds }).route, "HOLD");
  assert.equal(decidePublish({ mode: "REVIEW", killSwitch: false, autoPostEnabled: true, manual: false, draft: clean, thresholds }).route, "HOLD");
  assert.equal(decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: false, manual: false, draft: clean, thresholds }).route, "HOLD");
  assert.equal(decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: clean, thresholds }).route, "PUBLISH");
  assert.equal(decidePublish({ mode: "OFF", killSwitch: false, autoPostEnabled: true, manual: true, draft: clean, thresholds }).route, "BLOCK");
  assert.equal(decidePublish({ mode: "AUTO", killSwitch: true, autoPostEnabled: true, manual: true, draft: clean, thresholds }).route, "BLOCK");
  assert.equal(decidePublish({ mode: "REVIEW", killSwitch: false, autoPostEnabled: false, manual: true, draft: clean, thresholds }).route, "PUBLISH");
});

test("risk-based publishing: risky or low-confidence drafts go to review even in AUTO", () => {
  const risky = decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: { ...clean, riskScore: 55 }, thresholds });
  assert.equal(risky.route, "REVIEW");
  const unsure = decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: { ...clean, confidence: 60 }, thresholds });
  assert.equal(unsure.route, "REVIEW");
  const flagged = decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: { ...clean, status: "NEEDS_REVIEW", reviewReason: "число без атрибуции" }, thresholds });
  assert.equal(flagged.route, "REVIEW");
});

test("Test 10: expired breaking news is blocked from publishing", () => {
  const expired = decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: { ...clean, expiresAt: new Date(Date.now() - 1000) }, thresholds });
  assert.equal(expired.route, "BLOCK");
  assert.match(expired.reason, /просрочен/);
  const manualExpired = decidePublish({ mode: "REVIEW", killSwitch: false, autoPostEnabled: false, manual: true, draft: { ...clean, expiresAt: new Date(Date.now() - 1000) }, thresholds });
  assert.equal(manualExpired.route, "BLOCK");
});

test("scheduling respects the daily cap, the minimum gap and preferred hours; P0 skips the gap and hours", () => {
  const base = { maxPostsPerDay: 6, minimumMinutesBetweenPosts: 90, preferredHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], timezone: "Europe/Moscow" };
  const noonMoscow = new Date("2026-09-14T09:00:00Z"); // 12:00 MSK
  assert.equal(decideSlot({ ...base, now: noonMoscow, lastPublishedAt: null, postsToday: 6, priority: "P1" }).kind, "blocked");
  const gap = decideSlot({ ...base, now: noonMoscow, lastPublishedAt: new Date(noonMoscow.getTime() - 30 * 60_000), postsToday: 1, priority: "P2" });
  assert.equal(gap.kind, "at");
  if (gap.kind === "at") assert.equal(gap.at.getTime(), noonMoscow.getTime() + 60 * 60_000);
  const breaking = decideSlot({ ...base, now: noonMoscow, lastPublishedAt: new Date(noonMoscow.getTime() - 30 * 60_000), postsToday: 1, priority: "P0" });
  assert.equal(breaking.kind, "now");
  const night = new Date("2026-09-14T00:30:00Z"); // 03:30 MSK
  const late = decideSlot({ ...base, now: night, lastPublishedAt: null, postsToday: 0, priority: "P2" });
  assert.equal(late.kind, "at");
  if (late.kind === "at") assert.equal(hourInZone(late.at, "Europe/Moscow"), 9);
  assert.equal(decideSlot({ ...base, now: night, lastPublishedAt: null, postsToday: 0, priority: "P0" }).kind, "now");
});

const vf = (over: Partial<VerifiedFact>): VerifiedFact => ({ claim: "", type: "price", certainty: "FACT", confidence: 0.9, requiresVerification: true, isDynamic: true, asset: "BTC", value: null, unit: "USD", status: "VERIFIED", evidence: null, observedValue: null, checkedAt: null, ...over });

test("freshness recheck flags a stale price that is still in the text and leaves others alone", async () => {
  const provider: MarketDataProvider = { name: "fake", async getQuote() { return { symbol: "BTC", name: "Bitcoin", priceUsd: 96_000, change24hPct: -1, change7dPct: 0, marketCapUsd: null, volume24hUsd: null, fetchedAt: new Date(), provider: "fake" }; } };
  const facts = [vf({ claim: "BTC trades at $101,500", value: 101_500 }), vf({ claim: "BTC up 3% in 24h", value: 3, unit: "percent", type: "number" })];
  const stale = await recheckDynamicFacts("Биткоин около $101 500, плюс 3% за сутки.", facts, provider);
  assert.equal(stale.fresh, false);
  assert.equal(stale.drifted.length, 2);
  assert.equal(stale.updatedFacts[0]!.value, 96_000);
  const notInText = await recheckDynamicFacts("Приток в ETF снова вырос, институционалы вернулись.", facts, provider);
  assert.equal(notInText.fresh, true);
});

function memoryStore(): AttemptStore & { rows: Map<string, AttemptRecord> } {
  const rows = new Map<string, AttemptRecord>();
  return {
    rows,
    async get(key) {
      return rows.get(key) ?? null;
    },
    async start(key) {
      if (rows.has(key)) return false;
      rows.set(key, { idempotencyKey: key, status: "STARTED", containerId: null, postId: null, error: null, createdAt: new Date() });
      return true;
    },
    async update(key, patch) {
      const r = rows.get(key)!;
      rows.set(key, { ...r, ...patch });
    },
  };
}

function scriptedClient(script: { onPublish: () => "ok" | "timeout"; posts: () => Array<{ id: string; text: string }> }, calls: string[]): ThreadsClient {
  return new ThreadsClient({
    accessToken: "t",
    userId: "1",
    minRequestIntervalMs: 0,
    maxRetries: 0,
    requestTimeoutMs: 200,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const p = url.pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${p}`);
      if (method === "POST" && p.endsWith("/1/threads")) return new Response(JSON.stringify({ id: "c1" }), { status: 200 });
      if (p.endsWith("/c1")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (p.endsWith("/threads_publish")) {
        if (script.onPublish() === "timeout") {
          // Honour the abort signal like real fetch: the client gives up before Meta answers.
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 400);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return new Response(JSON.stringify({ id: "post-1" }), { status: 200 });
      }
      if (method === "GET" && p.endsWith("/1/threads")) return new Response(JSON.stringify({ data: script.posts() }), { status: 200 });
      if (p.endsWith("/post-1")) return new Response(JSON.stringify({ id: "post-1", permalink: "https://threads.net/p/1" }), { status: 200 });
      if (p.endsWith("/1/replies")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ data: script.posts() }), { status: 200 });
    }) as typeof fetch,
  });
}

test("Test 5: a publish timeout followed by a retry does not create a duplicate post", async () => {
  const calls: string[] = [];
  let publishCalls = 0;
  const live: Array<{ id: string; text: string }> = [];
  const client = scriptedClient(
    {
      onPublish: () => {
        publishCalls++;
        // The first publish "goes through" on Meta's side but our request times out.
        live.push({ id: "post-1", text: "Тестовый пост про ETF" });
        return "timeout";
      },
      posts: () => live,
    },
    calls,
  );
  const store = memoryStore();
  const publisher = new ThreadsPublisher(client, store);
  // First attempt: times out after publish; recovery finds the live post immediately.
  const first = await publisher.publish({ key: "draft:abc", kind: "post", text: "Тестовый пост про ETF" });
  assert.equal(first.id, "post-1");
  assert.equal(first.recovered, true);
  assert.equal(store.rows.get("draft:abc")!.status, "PUBLISHED");
  // Second attempt (job retry): must not touch the publish endpoint again.
  const before = publishCalls;
  const second = await publisher.publish({ key: "draft:abc", kind: "post", text: "Тестовый пост про ETF" });
  assert.equal(second.id, "post-1");
  assert.equal(publishCalls, before);
  assert.equal(calls.filter((p) => p.endsWith("/threads_publish")).length, 1);
});

test("a retry of an UNKNOWN attempt whose post cannot be found stops instead of re-sending", async () => {
  const calls: string[] = [];
  const client = scriptedClient({ onPublish: () => "ok", posts: () => [] }, calls);
  const store = memoryStore();
  await store.start("draft:x", "post");
  await store.update("draft:x", { status: "UNKNOWN", containerId: "c1" });
  // Container reports FINISHED (not yet published) → safe to publish the same container once.
  const publisher = new ThreadsPublisher(client, store);
  const res = await publisher.publish({ key: "draft:x", kind: "post", text: "Текст" });
  assert.equal(res.id, "post-1");
  assert.equal(calls.filter((p) => p === "POST /v1.0/1/threads").length, 0, "no new container was created");
});
