import { test } from "node:test";
import assert from "node:assert/strict";
import { authCookieValue, isAuthorized } from "../../src/api/auth.js";
import type { FastifyRequest } from "fastify";
import { loadEnv } from "../../src/config/env.js";
import { splitIntoThreadParts, THREADS_MAX_CHARS } from "../../src/shared/threadSplit.js";
import { scrubSecrets } from "../../src/shared/logger.js";

const req = (headers: Record<string, string>): FastifyRequest => ({ headers, url: "/threads/" } as unknown as FastifyRequest);

test("shared site cookie sha256(gudini:<password>) opens the service; wrong cookie does not", () => {
  const pw = "secret";
  assert.equal(isAuthorized(req({}), ""), true);
  assert.equal(isAuthorized(req({ cookie: `gudini_auth=${authCookieValue(pw)}` }), pw), true);
  assert.equal(isAuthorized(req({ cookie: "gudini_auth=nope" }), pw), false);
  assert.equal(isAuthorized(req({ authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` }), pw), true);
});

test("env validation names the missing variable", () => {
  assert.throws(() => loadEnv({ REDIS_URL: "redis://x" }), /DATABASE_URL/);
  const e = loadEnv({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", DRY_RUN: "true", THREADS_URL_PREFIX: "/threads/" });
  assert.equal(e.DRY_RUN, true);
  assert.equal(e.THREADS_URL_PREFIX, "/threads");
  assert.equal(e.AUTO_POST_ENABLED, false);
});

test("long text splits into ≤500-char numbered parts", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Предложение номер ${i + 1} про биткоин и рынок.`).join(" ");
  const parts = splitIntoThreadParts(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= THREADS_MAX_CHARS, `part too long: ${p.length}`);
  assert.match(parts[0]!, /^1\/\d /);
});

test("scrubSecrets removes tokens from messages", () => {
  const s = scrubSecrets("failed https://graph.threads.net/v1.0/me?access_token=THAAABBBCCCDDDEEEFFFGGGHHH&fields=id Bearer sk-ant-abcdefghijkl");
  assert.doesNotMatch(s, /THAAABBB/);
  assert.doesNotMatch(s, /sk-ant-abcdefghijkl/);
});
