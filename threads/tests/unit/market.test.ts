import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMoves, moveFacts, type MarketCoin, type MoveRow } from "../../src/services/market/movers.js";
import { WRITER_SYSTEM_PROMPT, closingPrompt, recentEndings, tradeLinkFrom } from "../../src/services/writer/prompts.js";
import { validateDraft, withoutLinks } from "../../src/services/writer/validate.js";
import { needsXVariant, xVariantProblems } from "../../src/services/writer/xVariant.js";
import { replyLanguageFor, validateReply } from "../../src/services/replies/writer.js";
import { personaBlock } from "../../src/services/persona.js";
import { decidePublish } from "../../src/services/publishing/gate.js";
import { textFor } from "../../src/services/publishing/pipeline.js";
import { draftAttemptKey, interactionAttemptKey } from "../../src/db/repos/publishing.js";
import { defaultSettings } from "../../src/config/settings.js";
import { loadEnv, setEnvForTests } from "../../src/config/env.js";

setEnvForTests(loadEnv({ DATABASE_URL: "postgres://unused", REDIS_URL: "redis://unused", NODE_ENV: "test" }));

const coin = (p: Partial<MarketCoin> & { symbol: string }): MarketCoin => ({ id: p.symbol.toLowerCase(), name: p.symbol, price: 10, marketCap: 1e9, rank: 50, volume24h: 1e8, change1h: 0, change24h: 0, ...p });
const thresholds = { minChange24hPct: 15, minChange1hPct: 8, minVolumeUsd: 20_000_000, ignore: ["USDT", "WBTC"] };

test("movers: loud daily and hourly moves are found, ranked by size; stables, thin volume and quiet coins are not", () => {
  const moves = detectMoves(
    [
      coin({ symbol: "SOL", change24h: 18.4 }),
      coin({ symbol: "DOGE", change24h: -22.1 }),
      coin({ symbol: "HYPE", change1h: 9.5, change24h: 11 }),
      coin({ symbol: "ETH", change24h: 4 }),
      coin({ symbol: "USDT", change24h: 40 }),
      coin({ symbol: "THIN", change24h: 60, volume24h: 1_000_000 }),
      coin({ symbol: "NOPRICE", price: 0, change24h: 90 }),
    ],
    thresholds,
  );
  assert.deepEqual(moves.map((m) => [m.coin.symbol, m.direction, m.period]), [["DOGE", "DOWN", "24h"], ["SOL", "UP", "24h"], ["HYPE", "UP", "1h"]]);
});

test("mover facts: price and the daily change are dynamic (re-checked before publishing), an hourly spike is not", () => {
  const row = { symbol: "SOL", name: "Solana", period: "24h", change_pct: 18.44, price: 212.4, volume_24h: 9.1e9, market_cap: 1e11, rank: 5, data_json: null } as unknown as MoveRow;
  const facts = moveFacts(row);
  assert.deepEqual(facts.filter((f) => f.isDynamic).map((f) => [f.unit, f.value]), [["USD", 212.4], ["percent", 18.4]]);
  assert.ok(facts.every((f) => f.status === "VERIFIED" && f.asset === "SOL"));
  assert.equal(moveFacts({ ...row, period: "1h" } as MoveRow).filter((f) => f.isDynamic).length, 1);
});

test("X variant: needed for long text, English or links; it may not add numbers, links or exceed the limit", () => {
  const x = defaultSettings().platforms.x;
  assert.equal(needsXVariant("Короткий пост без ссылок", x), false);
  assert.equal(needsXVariant("а".repeat(300), x), true);
  assert.equal(needsXVariant("Читать: https://site.com/post", x), true);
  // Links live in the profile now, so even with allowLinks on X gets its own text without one.
  assert.equal(needsXVariant("Читать: https://site.com/post", { ...x, allowLinks: true }), true);
  assert.equal(needsXVariant("Короткий пост", { ...x, language: "en" }), true);
  assert.equal(needsXVariant("а".repeat(300), { ...x, enabled: false }), false);
  const source = "SOL вырос на 18.4% за сутки до $212, объём $9.1 млрд. Причины пока не вижу.";
  const o = { maxChars: 280, language: "ru" as const };
  assert.deepEqual(xVariantProblems("SOL +18.4% за сутки, уже $212. Причины не вижу.", source, o), []);
  assert.ok(xVariantProblems("SOL +25% за сутки, уже $212.", source, o).some((p) => p.includes("25")));
  assert.ok(xVariantProblems("SOL +18.4%, детали: https://x.com/a", source, o).some((p) => p.includes("ссылка")));
  assert.ok(xVariantProblems("а".repeat(281), source, o).some((p) => p.includes("длина")));
  assert.ok(xVariantProblems("SOL is up 18.4% today, now at $212.", source, o).some((p) => p.includes("русском")));
  assert.deepEqual(xVariantProblems("SOL is up 18.4% today, now at $212. No clear reason yet.", source, { ...o, language: "en" }), []);
});

test("replies follow the commenter's language and are judged in it", () => {
  assert.equal(replyLanguageFor("А почему не держал дальше?"), "ru");
  assert.equal(replyLanguageFor("why did you close so early?"), "en");
  assert.equal(replyLanguageFor("🔥🔥"), "ru");
  const post = "Closed my BTC long at 63,540.";
  assert.deepEqual(validateReply("Took profit at my level, the move was done for me.", { ourPost: post, language: "en" }), []);
  assert.ok(validateReply("Забрал по своему уровню, движение для меня закончилось.", { ourPost: post, language: "en" }).some((v) => v.code === "WRONG_LANGUAGE"));
  assert.ok(validateReply("Great question! I closed at my level.", { ourPost: post, language: "en" }).some((v) => v.code === "TEMPLATE_OPENER"));
  assert.ok(validateReply("you should buy now, it will pump", { ourPost: post, language: "en" }).some((v) => v.code === "FINANCIAL_ADVICE"));
});

test("persona: first person, no invented trades, optional English", () => {
  const s = defaultSettings();
  s.persona = { name: "Алмаз", bio: "Торгую перпы на Hyperliquid", tone: "коротко", rules: "не обсуждаю размер депозита" };
  const block = personaBlock(s);
  assert.ok(block.includes("от первого лица") && block.includes("Алмаз. Торгую перпы на Hyperliquid") && block.includes("не обсуждаю размер депозита"));
  assert.ok(block.includes("Не выдумывай сделки"));
  assert.ok(!block.includes("LANGUAGE"));
  assert.ok(personaBlock(s, { language: "en" }).includes("English"));
});

test("two platforms: per-platform text, per-platform idempotency keys, PARTIAL drafts may continue", () => {
  assert.equal(textFor({ text: "длинный текст для Threads", text_x: "short for X" }, "x"), "short for X");
  assert.equal(textFor({ text: "длинный текст для Threads", text_x: "  " }, "x"), "длинный текст для Threads");
  assert.equal(textFor({ text: "длинный текст для Threads", text_x: "short for X" }, "threads"), "длинный текст для Threads");
  const id = "3f0e2c9a-1111-4222-8333-444455556666";
  assert.deepEqual([draftAttemptKey(id, "threads"), draftAttemptKey(id, "x")], [`draft:${id}`, `draft:${id}:x`]);
  assert.deepEqual([interactionAttemptKey(id, "threads"), interactionAttemptKey(id, "x")], [`interaction:${id}`, `interaction:${id}:x`]);
  const gate = decidePublish({ mode: "AUTO", killSwitch: false, autoPostEnabled: true, manual: false, draft: { status: "PARTIAL", riskScore: 10, confidence: 95, totalScore: 100, expiresAt: null, reviewReason: null }, thresholds: { maxRisk: 30, minConfidence: 85, minScore: 75 } });
  assert.equal(gate.route, "PUBLISH");
});

test("closing: no link in the text on either platform, only an optional nod to the profile that never repeats", () => {
  const used = "Фандинг перегрет, я пока сижу в стороне и просто смотрю за стаканом.";
  const block = closingPrompt({ forX: true, recentEndings: [used] });
  assert.ok(block.includes("Ссылок в тексте нет") && block.includes("описании профиля") && block.includes(used));
  // Nothing that looks like an address may reach the model — the owner fills the profile in himself.
  assert.ok(!/https?:\/\/|\.xyz|\.com|@[a-z]/i.test(block), block);
  assert.ok(block.includes("xText") && !closingPrompt().includes("xText"));
  assert.ok(block.includes("не в каждом посте") && block.includes("каждый раз заново"));
  for (const banned of ["подписывайтесь", "переходи по ссылке", "жми", "не упусти", "100x", "реклама"]) {
    assert.ok(block.includes(banned), banned);
  }
  // The same rule reaches the news post, which gets the prompt as a constant.
  assert.ok(WRITER_SYSTEM_PROMPT.includes("Ссылок в тексте нет"));
});

// The link no longer goes into a post; the setting is kept for the card and the profile description.
test("trade link: the settings section wins over env, a missing section breaks nothing", () => {
  assert.deepEqual(tradeLinkFrom({ tradeLink: { enabled: true, url: "https://ex.io/r/a", note: "реф", profileHint: "@me" } }), { enabled: true, url: "https://ex.io/r/a", note: "реф", profileHint: "@me" });
  assert.equal(tradeLinkFrom({ tradeLink: { enabled: false, url: "https://ex.io/r/a" } }).enabled, false);
  assert.equal(tradeLinkFrom({ tradeLink: { url: "https://ex.io/r/a" } }).enabled, true);
  process.env.TRADE_LINK_URL = "https://env.io/r/b";
  try {
    assert.equal(tradeLinkFrom(defaultSettings()).url, "https://env.io/r/b");
  } finally {
    delete process.env.TRADE_LINK_URL;
  }
  assert.equal(tradeLinkFrom(defaultSettings()).enabled, false);
  assert.equal(tradeLinkFrom(undefined).enabled, false);
});

test("endings: the closing line is remembered without its link, and the same one is kept once", () => {
  const tail = "Фандинг перегрет, я пока сижу в стороне и просто смотрю за стаканом на Hyperliquid.";
  const endings = recentEndings([
    `BTC снова у максимума. ${tail}\nhttps://app.hyperliquid.xyz/join/A`,
    `ETH тихо подрос. ${tail}`,
    "Разобрал механику перпов. Сам торгую их там же, адрес в профиле.",
  ]);
  assert.deepEqual(endings, [tail, "Разобрал механику перпов. Сам торгую их там же, адрес в профиле."]);
});

test("validation: a link in the text is blocked on both platforms; the mention of the profile is not", () => {
  const facts = moveFacts({ symbol: "SOL", name: "Solana", period: "24h", change_pct: 18.4, price: 212.4, volume_24h: 9.1e9, market_cap: 1e11, rank: 5, data_json: null } as unknown as MoveRow);
  const body = "SOL за сутки прибавил 18.4% и стоит $212.4. Причины я пока не вижу, но такие рывки я как раз и ловлю в перпах.";
  const text = `${body}\nhttps://app.hyperliquid.xyz/join/ALMAZ2024`;
  // Threads and X are checked the same way: the owner keeps his links in the profile, not in a post.
  for (const maxChars of [500, 280]) {
    assert.deepEqual(validateDraft(text, facts, { maxChars, links: "none" }).violations.map((v) => [v.code, v.severity]), [["LINK_NOT_ALLOWED", "block"]]);
  }
  assert.deepEqual(validateDraft(`${body} Где торгую и что разбираю — всё собрано у меня в профиле.`, facts, { maxChars: 500, links: "none" }).violations, []);
  assert.ok(!withoutLinks(text).includes("hyperliquid.xyz"));
});

test("validation: an ad for the account is blocked, an honest closing line is not", () => {
  assert.deepEqual(validateDraft("Держу лонг по SOL и смотрю за фандингом. Торгую это на Hyperliquid — адрес есть у меня в профиле.", [], { maxChars: 500 }).violations, []);
  for (const bad of [
    "Подписывайтесь, чтобы не пропустить следующий разбор рынка криптовалют.",
    "Переходи по ссылке и заработай на этом движении рынка уже сегодня.",
    "Не упустите: на этом рынке можно сделать лёгкие деньги за одну неделю.",
  ]) {
    assert.ok(validateDraft(bad, [], { maxChars: 500 }).violations.some((v) => v.code === "FORBIDDEN_PHRASE"), bad);
  }
});
