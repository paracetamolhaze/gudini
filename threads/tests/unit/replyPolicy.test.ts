import { test } from "node:test";
import assert from "node:assert/strict";
import { replyHold, similarReply, type RecentReply } from "../../src/services/replies/policy.js";
import { passesReview } from "../../src/services/replies/review.js";

const now = new Date("2026-09-15T12:00:00Z");
const input = { text: "Рост комиссий показывает спрос на блокспейс, но не гарантирует спрос на сам токен.", username: "alice", rootId: "p1", public: true, targetAt: new Date(now.getTime() - 3600000) };
const previous = (patch: Partial<RecentReply> = {}): RecentReply => ({ text: "Ликвидность пула влияет на проскальзывание при обмене.", username: "bob", rootId: "p2", public: true, at: new Date(now.getTime() - 3600000), ...patch });
test("new substantive reply is allowed; public cooldown lasts thirty minutes", () => {
  assert.equal(replyHold(input, [previous()], now), null);
  assert.equal(replyHold(input, [previous({ at: new Date(now.getTime() - 60000) })], now)?.permanent, false);
});
test("public replies do not revisit the same author or stale conversations", () => {
  assert.equal(replyHold(input, [previous({ username: "ALICE" })], now)?.permanent, true);
  assert.equal(replyHold({ ...input, targetAt: null }, [], now)?.permanent, true);
  assert.equal(replyHold({ ...input, targetAt: new Date(now.getTime() - 25 * 3600000) }, [], now)?.permanent, true);
});
test("repeated wording is blocked across authors and punctuation", () => {
  assert.equal(similarReply(input.text, input.text.toUpperCase().replaceAll(",", "!")), true);
  assert.equal(replyHold(input, [previous({ text: input.text })], now)?.permanent, true);
});
test("own conversations allow two replies per person and use an independent cooldown", () => {
  const own = { ...input, public: false };
  const r = previous({ public: false, rootId: "p1", username: "alice" });
  assert.equal(replyHold(own, [r], now), null);
  assert.equal(replyHold(own, [r, r], now)?.permanent, true);
  assert.equal(replyHold(own, [previous({ at: now })], now), null);
  assert.equal(replyHold(own, [previous({ public: false, at: now })], now)?.permanent, false);
});
test("pre-send review fails closed on irrelevant, empty, ungrounded or unsafe replies", () => {
  const good = { cryptoRelevant: true, addsValue: true, grounded: true, safe: true, reason: "Пояснение механизма" };
  assert.equal(passesReview(good), true);
  for (const key of ["cryptoRelevant", "addsValue", "grounded", "safe"] as const) assert.equal(passesReview({ ...good, [key]: false }), false);
});
