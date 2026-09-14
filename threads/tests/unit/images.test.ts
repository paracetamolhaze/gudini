import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { isPrivateAddress, assertPublicUrl, UnsafeUrlError, downloadImage } from "../../src/services/images/download.js";
import { classifyBlocks } from "../../src/services/images/classify.js";
import { evaluateImageQa } from "../../src/services/images/qa.js";
import { translateImageBuffer } from "../../src/services/images/pipeline.js";
import { findFontPaths, loadFonts } from "../../src/services/images/fonts.js";
import { fitText } from "../../src/services/images/render.js";
import { LlmRouter } from "../../src/llm/index.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/llm/provider.js";
import { loadEnv } from "../../src/config/env.js";
import type { OcrBlock, OcrResult, PlacedBlock } from "../../src/services/images/schemas.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("SSRF guard: private, loopback, link-local and metadata addresses are rejected", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.1.68", "169.254.169.254", "::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), UnsafeUrlError);
  await assert.rejects(() => assertPublicUrl("http://localhost/x.png"), UnsafeUrlError);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data"), UnsafeUrlError);
  await assert.rejects(() => assertPublicUrl("https://internal.example/x.png", async () => ["10.0.0.5"]), UnsafeUrlError);
  const ok = await assertPublicUrl("https://cdn.example.com/a.jpg", async () => ["93.184.216.34"]);
  assert.equal(ok.hostname, "cdn.example.com");
});

test("download enforces content type, size and redirect targets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "threads-img-"));
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret.png" } });
    if (url.endsWith("/html")) return new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
  }) as typeof fetch;
  const lookup = async () => ["93.184.216.34"];
  const r = await downloadImage("https://cdn.example.com/a.png", { dir, fetchImpl, lookup });
  assert.equal(r.width, 40);
  await assert.rejects(() => downloadImage("https://cdn.example.com/html", { dir, fetchImpl, lookup }), /not an image/);
  await assert.rejects(() => downloadImage("https://cdn.example.com/redirect", { dir, fetchImpl, lookup }), UnsafeUrlError);
  await assert.rejects(() => downloadImage("https://cdn.example.com/a.png", { dir, fetchImpl, lookup, maxBytes: 10 }), /too large/);
});

const block = (over: Partial<OcrBlock>): OcrBlock => ({ id: 0, text: "x", bbox: { x: 50, y: 50, w: 500, h: 80 }, role: "headline", language: "en", fontSize: 60, bold: true, color: "#111111", background: "#ffffff", alignment: "left", rotation: 0, confidence: 0.95, lines: 1, ...over });

test("classification keeps tickers, URLs, brands, handles, addresses and tiny UI text untranslated", () => {
  const out = classifyBlocks([
    block({ id: 0, text: "BITCOIN BREAKS $100K" }),
    block({ id: 1, text: "$BTC", role: "ticker" }),
    block({ id: 2, text: "coindesk.com", role: "caption" }),
    block({ id: 3, text: "@cryptonews", role: "caption" }),
    block({ id: 4, text: "0x1234567890abcdef", role: "body" }),
    block({ id: 5, text: "CoinDesk", role: "brand" }),
    block({ id: 6, text: "Settings", role: "ui" }),
    block({ id: 7, text: "Volume", role: "label", bbox: { x: 0, y: 0, w: 100, h: 8 } }),
    block({ id: 8, text: "Net inflows hit $650M", role: "body" }),
  ]);
  const translate = out.filter((b) => b.translate).map((b) => b.id);
  assert.deepEqual(translate, [0, 8]);
});

test("QA catches lost numbers, leftover English and missing Cyrillic", () => {
  const blocks: PlacedBlock[] = [
    { ...block({ id: 0, text: "Net inflows hit $650M" }), translate: true, translation: "Приток достиг $650M", rendered: { fontPx: 30, lines: ["Приток достиг $650M"], usedShorter: false, overflow: false } },
  ];
  const good: OcrResult = { hasText: true, imageDescription: "", blocks: [block({ text: "Приток достиг $650M", language: "ru" })] };
  assert.equal(evaluateImageQa(blocks, good).passed, true);
  const lostNumber: OcrResult = { hasText: true, imageDescription: "", blocks: [block({ text: "Приток достиг $65M", language: "ru" })] };
  const r1 = evaluateImageQa(blocks, lostNumber);
  assert.equal(r1.passed, false);
  assert.deepEqual(r1.numbersMissing, ["650"]);
  const englishLeft: OcrResult = { hasText: true, imageDescription: "", blocks: [block({ text: "Net inflows hit $650M" }), block({ text: "Приток $650M", language: "ru" })] };
  assert.ok(evaluateImageQa(blocks, englishLeft).issues.some((i) => /английский/.test(i)));
});

test("text fitting shrinks the font and falls back to the shorter variant before overflowing", async () => {
  if (!findFontPaths()) return; // no TTF on this machine; the Docker image ships DejaVu
  const fonts = await loadFonts();
  const fit = fitText(fonts.bold, "БИТКОИН ПРОБИЛ ОТМЕТКУ В СТО ТЫСЯЧ ДОЛЛАРОВ", "БИТКОИН ПРОБИЛ $100K", { w: 300, h: 60 }, 48, { minFontPx: 14 });
  assert.ok(fit.fits);
  assert.ok(fit.fontPx >= 14);
  const impossible = fitText(fonts.bold, "Очень длинный текст, который никак не поместится в такой маленький прямоугольник", undefined, { w: 60, h: 12 }, 40, { minFontPx: 14 });
  assert.equal(impossible.fits, false);
});

class VisionScript implements LlmProvider {
  readonly name = "fake";
  calls = 0;
  constructor(private readonly answers: Array<() => unknown>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const fn = this.answers[this.calls++] ?? this.answers[this.answers.length - 1]!;
    return { text: JSON.stringify(fn()), usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, provider: "fake" };
  }
  async test() {
    return { ok: true, message: "" };
  }
}

test("Test 9: English image → Russian image keeps the required numbers (scripted vision model)", async () => {
  if (!findFontPaths()) return;
  // A white 800x400 card with a dark headline area drawn as a rectangle (the OCR is scripted).
  const original = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(`<svg width="800" height="400"><rect x="40" y="40" width="720" height="120" fill="#f2f2f2"/><text x="60" y="120" font-size="64" font-family="sans-serif" font-weight="bold" fill="#111">ETF INFLOWS HIT $650M</text><text x="60" y="360" font-size="28" font-family="sans-serif" fill="#555">@cryptonews · coindesk.com</text></svg>`), left: 0, top: 0 }])
    .png()
    .toBuffer();
  const sourceOcr: OcrResult = {
    hasText: true,
    imageDescription: "infographic headline",
    blocks: [
      block({ id: 0, text: "ETF INFLOWS HIT $650M", bbox: { x: 60, y: 130, w: 780, h: 180 }, fontSize: 120, alignment: "left" }),
      block({ id: 1, text: "@cryptonews · coindesk.com", role: "caption", bbox: { x: 60, y: 830, w: 500, h: 80 }, fontSize: 50, bold: false }),
    ],
  };
  const finalOcr: OcrResult = { hasText: true, imageDescription: "", blocks: [block({ id: 0, text: "ПРИТОК В ETF ДОСТИГ $650M", language: "ru" }), block({ id: 1, text: "@cryptonews · coindesk.com", role: "caption" })] };
  const provider = new VisionScript([() => sourceOcr, () => ({ translations: [{ id: 0, text: "ПРИТОК В ETF ДОСТИГ $650M", shorter: "ETF: +$650M" }] }), () => finalOcr]);
  const router = new LlmRouter(loadEnv({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", LLM_PROVIDER: "openrouter", LLM_MODEL_VISION: "fake:v", LLM_MODEL_TRANSLATION: "fake:t" }));
  router.registerProvider("fake", provider);
  const result = await translateImageBuffer(original, { minFontPx: 14, router });
  assert.equal(result.status, "QA_PASSED", JSON.stringify(result.qa));
  assert.ok(result.final && result.final.length > 1000);
  const meta = await sharp(result.final!).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.format, "jpeg");
  const headline = result.blocks.find((b) => b.id === 0)!;
  assert.equal(headline.translation, "ПРИТОК В ETF ДОСТИГ $650M");
  assert.equal(headline.rendered?.overflow, false);
  assert.equal(result.blocks.find((b) => b.id === 1)!.translate, false, "the attribution caption is never translated or removed");
  assert.equal(provider.calls, 3);
});
