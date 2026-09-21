import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizationHeader, percentEncode, sign, signatureBaseString } from "../../src/x/oauth1.js";
import { XClient, XDuplicateContentError, XReplyNotAllowedError, containsUrl, type XUsageKind } from "../../src/x/client.js";
import { XPublisher } from "../../src/x/publisher.js";
import { stripLinks } from "../../src/platforms/x.js";
import { splitIntoThreadParts } from "../../src/shared/threadSplit.js";
import { AuthenticationError, RateLimitError } from "../../src/threads/errors.js";
import type { AttemptRecord, AttemptStore } from "../../src/platforms/attempts.js";

const creds = { consumerKey: "ck", consumerSecret: "CONSUMER-SECRET-VALUE", accessToken: "at", accessSecret: "ACCESS-SECRET-VALUE" };

test("OAuth 1.0a signature matches the reference example from the X documentation", () => {
  // https://docs.x.com — "Creating a signature": the canonical statuses/update example.
  const params: Array<[string, string]> = [
    ["status", "Hello Ladies + Gentlemen, a signed OAuth request!"],
    ["include_entities", "true"],
    ["oauth_consumer_key", "xvz1evFS4wEEPTGEFPHBog"],
    ["oauth_nonce", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "1318622958"],
    ["oauth_token", "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"],
    ["oauth_version", "1.0"],
  ];
  const base = signatureBaseString("post", "https://api.twitter.com/1.1/statuses/update.json", params);
  assert.ok(base.startsWith("POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3D"));
  assert.ok(base.includes("status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"));
  assert.equal(sign(base, "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"), "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("percent-encoding is RFC 3986 and the header signs query parameters but never leaks secrets", () => {
  assert.equal(percentEncode("a b!*'()"), "a%20b%21%2A%27%28%29");
  const header = authorizationHeader(creds, { method: "GET", url: "https://api.x.com/2/users/me?user.fields=username", nonce: "n", timestamp: 1 });
  assert.match(header, /^OAuth oauth_consumer_key="ck", oauth_nonce="n", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1", oauth_token="at", oauth_version="1\.0"$/);
  assert.ok(!header.includes("CONSUMER-SECRET-VALUE") && !header.includes("ACCESS-SECRET-VALUE"));
  const other = authorizationHeader(creds, { method: "GET", url: "https://api.x.com/2/users/me?user.fields=name", nonce: "n", timestamp: 1 });
  assert.notEqual(header, other, "a different query string must change the signature");
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeX(handler: (call: Call) => { status?: number; json?: unknown }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    const call: Call = { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch, usage: Array<[XUsageKind, number]> = []) => new XClient({ credentials: creds, fetchImpl, minRequestIntervalMs: 0, maxRetries: 0, onUsage: (k, n) => usage.push([k, n]) });

test("X client: posts, replies and quotes go to /2/tweets with an OAuth header, and usage is priced by kind", async () => {
  const usage: Array<[XUsageKind, number]> = [];
  const fake = fakeX(() => ({ json: { data: { id: "1900" } } }));
  const x = client(fake.fetchImpl, usage);
  assert.deepEqual(await x.createPost({ text: "gm" }), { id: "1900" });
  await x.createPost({ text: "reply", replyToId: "55", summoned: true });
  await x.createPost({ text: "see https://example.com/a", quotedId: "77" });
  assert.equal(fake.calls[0]!.url, "https://api.x.com/2/tweets");
  assert.match(fake.calls[0]!.headers.authorization!, /^OAuth oauth_consumer_key="ck"/);
  assert.deepEqual(fake.calls[0]!.body, { text: "gm" });
  assert.deepEqual(fake.calls[1]!.body, { text: "reply", reply: { in_reply_to_tweet_id: "55" } });
  assert.deepEqual(fake.calls[2]!.body, { text: "see https://example.com/a", quote_tweet_id: "77" });
  assert.deepEqual(usage, [["post_create", 1], ["post_create_summoned", 1], ["post_create_url", 1]]);
});

test("X client: typed errors — reply restriction, duplicate content, auth, rate limit", async () => {
  const forbidden = client(fakeX(() => ({ status: 403, json: { title: "Forbidden", detail: "You are not permitted to perform this action." } })).fetchImpl);
  await assert.rejects(forbidden.createPost({ text: "hi", replyToId: "1" }), XReplyNotAllowedError);
  const dup = client(fakeX(() => ({ status: 403, json: { detail: "You are not allowed to create a Tweet with duplicate content." } })).fetchImpl);
  await assert.rejects(dup.createPost({ text: "hi" }), XDuplicateContentError);
  await assert.rejects(client(fakeX(() => ({ status: 401, json: { title: "Unauthorized" } })).fetchImpl).me(), AuthenticationError);
  await assert.rejects(client(fakeX(() => ({ status: 429, json: { title: "Too Many Requests" } })).fetchImpl).me(), RateLimitError);
  const empty = new XClient({ credentials: { ...creds, accessSecret: "" }, fetchImpl: fakeX(() => ({})).fetchImpl });
  assert.equal(empty.hasCredentials, false);
  await assert.rejects(empty.me(), AuthenticationError);
});

test("X client: mentions resolve authors and every returned post is billed as a read", async () => {
  const usage: Array<[XUsageKind, number]> = [];
  const fake = fakeX((call) =>
    call.url.includes("/users/me")
      ? { json: { data: { id: "42", username: "me" } } }
      : { json: { data: [{ id: "10", text: "@me nice trade", author_id: "7", conversation_id: "9", referenced_tweets: [{ type: "replied_to", id: "9" }] }], includes: { users: [{ id: "7", username: "anna" }] }, meta: { newest_id: "10" } } },
  );
  const res = await client(fake.fetchImpl, usage).mentions({ sinceId: "5" });
  assert.equal(res.newestId, "10");
  assert.equal(res.posts[0]!.author_username, "anna");
  assert.ok(fake.calls[1]!.url.includes("/2/users/42/mentions") && fake.calls[1]!.url.includes("since_id=5"));
  assert.deepEqual(usage, [["user_read", 1], ["post_read", 1]]);
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
      const cur = rows.get(key);
      if (cur) rows.set(key, { ...cur, ...patch, error: patch.error === undefined ? null : patch.error });
    },
  };
}

test("X publisher: a published key is never sent twice, and a duplicate rejection is recovered from the timeline", async () => {
  let creates = 0;
  const fake = fakeX((call) => {
    if (call.url.includes("/users/me")) return { json: { data: { id: "42", username: "me" } } };
    if (call.method === "POST") return { json: { data: { id: `p${++creates}` } } };
    return { json: { data: [] } };
  });
  const store = memoryStore();
  const pub = new XPublisher(client(fake.fetchImpl), store);
  const first = await pub.publish({ key: "draft:1:x", kind: "post", text: "closed my BTC long" });
  const again = await pub.publish({ key: "draft:1:x", kind: "post", text: "closed my BTC long" });
  assert.equal(first.id, "p1");
  assert.deepEqual([again.id, again.recovered], ["p1", true]);
  assert.equal(creates, 1);
  assert.equal(first.permalink, "https://x.com/me/status/p1");

  // X says "duplicate": the earlier attempt did go out — find it instead of failing or re-posting.
  const dupFake = fakeX((call) => {
    if (call.url.includes("/users/me")) return { json: { data: { id: "42", username: "me" } } };
    if (call.method === "POST") return { status: 403, json: { detail: "duplicate content" } };
    return { json: { data: [{ id: "p77", text: "closed my ETH short https://t.co/x" }] } };
  });
  const recovered = await new XPublisher(client(dupFake.fetchImpl), memoryStore()).publish({ key: "draft:2:x", kind: "post", text: "closed my ETH short" });
  assert.deepEqual([recovered.id, recovered.recovered], ["p77", true]);
});

test("X text rules: links are detected and stripped, long text splits at the platform limit", () => {
  assert.equal(containsUrl("читай https://site.com/a?b=1"), true);
  assert.equal(containsUrl("разбор на hyperliquid.xyz"), true);
  assert.equal(containsUrl("BTC x10, вход 61 200, т.к. тренд"), false);
  assert.equal(stripLinks("Закрыл лонг.\nhttps://app.hyperliquid.xyz/trade\nДальше смотрю ETH"), "Закрыл лонг.\nДальше смотрю ETH");
  const parts = splitIntoThreadParts("Слово ".repeat(120).trim(), 280);
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 280), `parts: ${parts.map((p) => p.length).join(",")}`);
  assert.match(parts[0]!, /^1\/\d /);
});
