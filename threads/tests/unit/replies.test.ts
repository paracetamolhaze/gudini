import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReply, ruleDecision } from "../../src/services/replies/decision.js";
import { validateReply } from "../../src/services/replies/writer.js";
import { preFilter, totalScore, scorePosts, freshnessScore } from "../../src/services/engagement/scoring.js";
import { LlmRouter } from "../../src/llm/index.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/llm/provider.js";
import { loadEnv } from "../../src/config/env.js";

class Scripted implements LlmProvider {
  readonly name = "fake";
  requests: LlmRequest[] = [];
  constructor(private readonly answer: unknown) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return { text: JSON.stringify(this.answer), usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, provider: "fake" };
  }
  async test() {
    return { ok: true, message: "" };
  }
}
const routerWith = (answer: unknown) => {
  const router = new LlmRouter(loadEnv({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", LLM_PROVIDER: "openrouter", LLM_MODEL_REPLY: "fake:r" }));
  const provider = new Scripted(answer);
  router.registerProvider("fake", provider);
  return { router, provider };
};

const base = { ourPost: "Спотовые биткоин-ETF привлекли $650 млн за день по данным Farside.", commenter: "user1", chain: [], priorFromSameUser: [], kind: "reply" as const };

test("Test 6: spam and empty comments are skipped by rules without spending a model call", async () => {
  const { router, provider } = routerWith({});
  for (const comment of ["🔥🔥🔥", "+", "первый", "Free airdrop! DM me for 1000 USDT https://t.me/scam", "ок"]) {
    const r = await decideReply({ ...base, comment, router });
    assert.equal(r.decision.action, "SKIP", comment);
    assert.equal(r.source, "rules");
  }
  assert.equal(provider.requests.length, 0);
  assert.equal(ruleDecision({ ...base, comment: "Круто", priorFromSameUser: ["Круто"] })?.reason, "повтор того же комментария от того же пользователя");
});

test("Test 7: a real question reaches the model and gets REPLY", async () => {
  const { router, provider } = routerWith({ action: "REPLY", reason: "конкретный вопрос про источник данных", sentiment: "neutral", toxicityScore: 5, confidence: 92 });
  const r = await decideReply({ ...base, comment: "А откуда цифра $650 млн? Farside считает только американские ETF или все?", router });
  assert.equal(r.decision.action, "REPLY");
  assert.equal(r.source, "model");
  const user = String(provider.requests[0]!.messages[0]!.content);
  assert.ok(user.includes("<untrusted_source_content>"));
});

test("reply validation rejects support-bot openers, hype, stray numbers and non-Russian", () => {
  const ctx = { ourPost: base.ourPost };
  assert.ok(validateReply("Отличный вопрос! Farside считает американские спотовые ETF.", ctx).some((v) => v.code === "TEMPLATE_OPENER"));
  assert.ok(validateReply("Согласен", ctx).some((v) => v.code === "MEANINGLESS"));
  assert.ok(validateReply("Покупаем на всё, 100x гарантирован", ctx).some((v) => v.code === "HYPE"));
  assert.ok(validateReply("Farside считает только американские спотовые ETF, притоки за вчера $900 млн.", ctx).some((v) => v.code === "STRAY_NUMBER"));
  assert.equal(validateReply("Farside считает только американские спотовые ETF: $650 млн — это сумма по всем эмитентам за один день.", ctx).length, 0);
  assert.ok(validateReply("Farside only counts US spot ETFs.", ctx).some((v) => v.code === "NOT_RUSSIAN"));
});

test("engagement scoring: spam is filtered before the model; totals weigh value-add most", async () => {
  const now = new Date("2026-09-14T12:00:00Z");
  assert.equal(preFilter({ id: "1", username: "a", text: "Free airdrop, DM me now!!! claim now", publishedAt: now, keyword: "crypto" }), "похоже на спам/раздачу");
  assert.ok(freshnessScore(new Date(now.getTime() - 8 * 3_600_000), now) <= 51);
  const strong = totalScore({ relevance: 90, freshness: 90, authorRelevance: 80, engagementPotential: 80, valueAdd: 90, spamRisk: 5 });
  const weak = totalScore({ relevance: 90, freshness: 90, authorRelevance: 80, engagementPotential: 80, valueAdd: 20, spamRisk: 5 });
  assert.ok(strong > weak + 15);
  const { router } = routerWith({ scores: [{ id: "p1", relevance: 85, authorRelevance: 70, engagementPotential: 75, valueAdd: 80, spamRisk: 5, angle: "уточнить, что притоки считаются только по США" }, { id: "p2", relevance: 30, authorRelevance: 40, engagementPotential: 30, valueAdd: 10, spamRisk: 20, angle: "" }] });
  const scored = await scorePosts(
    [
      { id: "p1", username: "trader", text: "Interesting: Bitcoin ETF inflows were huge yesterday, anyone knows if that includes Canadian funds too? Feels like institutional demand is back.", publishedAt: now, keyword: "bitcoin ETF" },
      { id: "p2", username: "rand", text: "gm everyone, what a beautiful day to be alive and stacking sats, love this community", publishedAt: now, keyword: "bitcoin" },
    ],
    { minimumScore: 70, router, now },
  );
  assert.equal(scored.find((s) => s.id === "p1")!.worth, true);
  assert.equal(scored.find((s) => s.id === "p2")!.worth, false);
});
