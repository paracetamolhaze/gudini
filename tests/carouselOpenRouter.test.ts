import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import zlib from "zlib";
import { chatText, generateImage, keyInfo, OpenRouterError, redactSecrets, setOpenRouterFetch } from "../lib/carousel/openrouter";
import { crc32 } from "../lib/carousel/zip";

/**
 * Клиент OpenRouter раздела на поддельной сети: ни один запрос наружу не уходит.
 * Проверяется форма запросов, разбор ответов и классификация ошибок — в том числе
 * «исход неизвестен» после тайм-аута, который нельзя повторять вслепую.
 */

const FAKE_KEY = "sk-or-test-1234567890abcdef";

function png(w = 4, h = 5): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

type Call = { url: string; init: RequestInit; body: any };
const calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

before(() => {
  process.env.CAROUSEL_OPENROUTER_API_KEY = FAKE_KEY;
  setOpenRouterFetch(async (url, init) => {
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call);
  });
});
after(() => setOpenRouterFetch(null));

test("текст: запрос с usage.include, ответ с текстом и точной ценой", async () => {
  calls.length = 0;
  respond = () => json(200, { choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.0031 } });
  const r = await chatText({ model: "anthropic/claude-sonnet-5", system: "s", user: "u", maxTokens: 500, timeoutMs: 5000 });
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.cost, 0.0031);
  assert.equal(r.promptTokens, 120);
  const call = calls[0];
  assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(call.body.usage, { include: true });
  assert.equal(call.body.model, "anthropic/claude-sonnet-5");
});

test("текст: обрезанный ответ — ошибка с ценой, пустой — ошибка", async () => {
  respond = () => json(200, { choices: [{ message: { content: "..." }, finish_reason: "length" }], usage: { cost: 0.01 } });
  await assert.rejects(chatText({ model: "m", system: "s", user: "u", maxTokens: 10, timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "truncated" && e.cost === 0.01);
  respond = () => json(200, { choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  await assert.rejects(chatText({ model: "m", system: "s", user: "u", maxTokens: 10, timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "bad_response");
});

test("картинка: параметры модели уходят как есть, референсы — data:URL, ответ разбирается по байтам", async () => {
  calls.length = 0;
  const buffer = png();
  respond = () => json(200, { data: [{ b64_json: buffer.toString("base64"), media_type: "image/jpeg" }], usage: { cost: 0.0972 } });
  const r = await generateImage({ model: "google/gemini-3.1-flash-image", prompt: "a cat", aspectRatio: "4:5", resolution: "2K", references: ["data:image/png;base64,AAAA"], timeoutMs: 5000 });
  assert.ok(r.buffer.equals(buffer));
  assert.equal(r.mediaType, "image/png", "тип по сигнатуре, а не по заявленному media_type");
  assert.equal(r.cost, 0.0972);
  const body = calls[0].body;
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
  assert.equal(body.aspect_ratio, "4:5");
  assert.equal(body.resolution, "2K");
  assert.equal(body.n, 1);
  assert.deepEqual(body.input_references, [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);

  calls.length = 0;
  await generateImage({ model: "openai/gpt-image-2", prompt: "a cat", aspectRatio: "3:4", resolution: null, quality: "medium", references: [], timeoutMs: 5000 });
  assert.equal("resolution" in calls[0].body, false, "модель без параметра разрешения его не получает");
  assert.equal(calls[0].body.quality, "medium");
  assert.equal("input_references" in calls[0].body, false);
});

test("картинка: ответ без изображения — ошибка без повтора", async () => {
  respond = () => json(200, { data: [], usage: { cost: 0 } });
  await assert.rejects(generateImage({ model: "m", prompt: "p", aspectRatio: "1:1", resolution: null, references: [], timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "bad_response" && !e.retryable && !e.uncertain);
});

test("ошибки: ключ, кредиты, частота, провайдер, модерация — с понятной классификацией", async () => {
  const run = () => generateImage({ model: "m", prompt: "p", aspectRatio: "1:1", resolution: null, references: [], timeoutMs: 5000 });
  respond = () => json(401, { error: { message: "No auth credentials found", code: 401 } });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "auth" && /CAROUSEL_OPENROUTER_API_KEY/.test(e.message));
  respond = () => json(402, { error: { message: "Insufficient credits", code: 402 } });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "credits" && !e.retryable);
  respond = () => json(429, { error: { message: "Rate limited", code: 429 } });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "rate_limit" && e.retryable && !e.uncertain);
  respond = () => json(502, { error: { message: "Provider returned error", code: 502 } });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "provider" && e.retryable);
  respond = () => json(400, { error: { message: "Your request was flagged for moderation", code: 400 } });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "moderation" && !e.retryable);
  respond = () => new Response("<html>bad gateway</html>", { status: 503 });
  await assert.rejects(run, (e: OpenRouterError) => e.kind === "provider");
});

test("тайм-аут и обрыв после отправки — исход неизвестен, автоматически не повторяется", async () => {
  respond = () => {
    const e = new Error("timeout");
    e.name = "TimeoutError";
    throw e;
  };
  await assert.rejects(generateImage({ model: "m", prompt: "p", aspectRatio: "1:1", resolution: null, references: [], timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "timeout" && e.uncertain && !e.retryable);
  respond = () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(chatText({ model: "m", system: "s", user: "u", maxTokens: 10, timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "network" && e.uncertain);
});

test("без ключа раздела запрос не отправляется вовсе", async () => {
  calls.length = 0;
  const key = process.env.CAROUSEL_OPENROUTER_API_KEY;
  delete process.env.CAROUSEL_OPENROUTER_API_KEY;
  try {
    await assert.rejects(chatText({ model: "m", system: "s", user: "u", maxTokens: 10, timeoutMs: 5000 }), (e: OpenRouterError) => e.kind === "no_key");
    assert.equal(calls.length, 0);
  } finally {
    process.env.CAROUSEL_OPENROUTER_API_KEY = key;
  }
});

test("ключ не попадает в тексты ошибок; лимит ключа читается без секрета", async () => {
  assert.equal(redactSecrets(`Bearer ${FAKE_KEY} and ${FAKE_KEY}`), "Bearer *** and ***");
  respond = () => json(400, { error: { message: `bad key ${FAKE_KEY}`, code: 400 } });
  await assert.rejects(chatText({ model: "m", system: "s", user: "u", maxTokens: 10, timeoutMs: 5000 }), (e: OpenRouterError) => !e.message.includes(FAKE_KEY));
  respond = () => json(200, { data: { label: "carousels", limit: 20, usage: 3.5, limit_remaining: 16.5 } });
  assert.deepEqual(await keyInfo(1000), { label: "carousels", limit: 20, usage: 3.5, remaining: 16.5 });
});
