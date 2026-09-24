import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mediaComplete, scriptTransport } from "../lib/mediaLlm";
import { ledger, resetLedger } from "../lib/costLedger";
import { generateScript } from "../lib/ai";
import { EXPLAINER_SYSTEM } from "../lib/explainerScript";
import { claudeBridgeComplete } from "../lib/claudeBridgeClient";

const keys = ["SCRIPT_LLM_TRANSPORT", "CLAUDE_BRIDGE_URL", "CLAUDE_BRIDGE_TOKEN", "CLAUDE_SCRIPT_MODEL"];
const token = "t".repeat(40);

async function withBridge(reply: (body: any) => { status: number; json: unknown }, fn: (seen: any[]) => Promise<void>) {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const { status, json } = reply(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.SCRIPT_LLM_TRANSPORT = "claude";
  process.env.CLAUDE_BRIDGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.CLAUDE_BRIDGE_TOKEN = token;
  delete process.env.CLAUDE_SCRIPT_MODEL;
  resetLedger();
  try { await fn(seen); }
  finally {
    server.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

test("сценарий пишет Claude через мост: Opus 5, задача script, подписка без цены", async () => withBridge(
  () => ({ status: 200, json: { text: "  Готовый сценарий  ", usage: { inputTokens: 900, outputTokens: 300 }, model: "claude-opus-5" } }),
  async seen => {
    const text = await mediaComplete({ stage: "Script Generation", system: "Правила сценария", user: "Тема: биткоин" });
    assert.equal(text, "Готовый сценарий");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/complete");
    assert.equal(seen[0].auth, `Bearer ${token}`);
    assert.deepEqual(seen[0].body, { system: "Правила сценария", messages: [{ role: "user", content: "Тема: биткоин" }], task: "script", model: "claude-opus-5" });
    const [entry] = ledger();
    assert.equal(entry.provider, "anthropic");
    assert.equal(entry.billing, "subscription");
    assert.equal(entry.estimatedCost, 0);
    assert.equal(entry.outputTokens, 300);
  },
));

test("отказ моста доходит до пользователя с причиной, без перехода на другого провайдера", async () => withBridge(
  () => ({ status: 429, json: { error: "Лимит подписки Claude исчерпан" } }),
  async seen => {
    await assert.rejects(mediaComplete({ stage: "Script Generation", system: "S", user: "U" }), /Мост Claude: Лимит подписки/);
    assert.equal(seen.length, 1);
  },
));

const answer = (text: string) => ({ status: 200, json: { text, usage: { inputTokens: 1, outputTokens: 1 }, model: "claude-opus-5" } });
const kindCall = (body: any) => body.system.includes("что обещает тема. Ответь одним словом");

test("объяснение Claude пишет одним вызовом, без поиска и без Codex", async () => withBridge(
  () => answer("Сценарий про биткоин"),
  async seen => {
    const { script } = await generateScript("Биткоин за минуту: объясняю так, чтобы понял младший брат");
    assert.equal(script, "Сценарий про биткоин");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.system, EXPLAINER_SYSTEM);
    assert.equal(seen[0].body.tools, undefined);
  },
));

test("тему без явного «объясняю» Claude сначала определяет: объяснение пишется без поиска", async () => withBridge(
  body => answer(kindCall(body) ? "EXPLAINER" : "Сценарий про сид-фразу"),
  async seen => {
    const { script } = await generateScript("Сид-фраза: 12 слов, которые стоят дороже твоего телефона");
    assert.equal(script, "Сценарий про сид-фразу");
    assert.equal(seen.length, 2);
    assert.ok(kindCall(seen[0].body));
    assert.equal(seen[1].body.system, EXPLAINER_SYSTEM);
    assert.equal(seen[1].body.tools, undefined);
  },
));

test("историю Claude пишет с веб-поиском, чтобы даты и суммы были свежими", async () => withBridge(
  body => answer(kindCall(body) ? "HISTORY" : "Сценарий про пиццу"),
  async seen => {
    const { script } = await generateScript("Пицца за 10 000 биткоинов: самый дорогой ужин в истории");
    assert.equal(script, "Сценарий про пиццу");
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1].body.system, EXPLAINER_SYSTEM);
    assert.equal(seen[1].body.tools, "web");
    assert.ok(seen.every(r => r.body.model === "claude-opus-5"));
  },
));

const busy = { status: 503, json: { error: "Мост Claude занят: очередь длиннее, чем задание успеет подождать. Повторите позже." } };
const request = { stage: "Script Generation" as const, model: "claude-opus-5", system: "S", user: "U", task: "script" };

test("пока Threads занимает мост, сценарий ждёт очереди и потом пишется", async () => {
  let calls = 0;
  await withBridge(() => (++calls < 3 ? busy : answer("Дождался")), async seen => {
    assert.equal(await claudeBridgeComplete(request, { retryDelayMs: 5, busyWaitMs: 1_000 }), "Дождался");
    assert.equal(seen.length, 3);
    assert.equal(ledger().length, 1);
  });
});

test("если мост занят дольше срока ожидания, пользователь видит причину", async () => withBridge(
  () => busy,
  async () => {
    await assert.rejects(claudeBridgeComplete(request, { retryDelayMs: 5, busyWaitMs: 30 }), /Мост Claude: Мост Claude занят/);
  },
));

test("по умолчанию сценарии остаются на общем транспорте, опечатка в настройке — ошибка", () => {
  const saved = process.env.SCRIPT_LLM_TRANSPORT;
  try {
    delete process.env.SCRIPT_LLM_TRANSPORT;
    assert.equal(scriptTransport(), "media");
    process.env.SCRIPT_LLM_TRANSPORT = "cluade";
    assert.throws(() => scriptTransport(), /допустимы claude и media/);
  } finally {
    if (saved === undefined) delete process.env.SCRIPT_LLM_TRANSPORT; else process.env.SCRIPT_LLM_TRANSPORT = saved;
  }
});
