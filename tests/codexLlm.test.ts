import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import { once } from "node:events";
import { codexArguments, codexEnvironment, codexError, codexModel, withCodexQueue, type CodexRequest } from "../lib/codexLlm";
import { mediaComplete, mediaVision, mediaLlmAvailable, mediaEngine } from "../lib/mediaLlm";
import { ledger, resetLedger, summarize } from "../lib/costLedger";
import { generateScript } from "../lib/ai";
import { buildStoryResearchPack } from "../lib/storyResearch";

const request: CodexRequest = { stage: "Script Generation", model: "gpt-6-astra", effort: "high", system: "JSON", user: "Тест" };
const envKeys = ["MEDIA_LLM_TRANSPORT", "MEDIA_LLM_PROVIDER", "ANTHROPIC_API_KEY", "CODEX_RUNS_DIR", "CODEX_BRIDGE_URL", "CODEX_BRIDGE_TOKEN", "CODEX_TIMEOUT_MS", "BRAVE_API_KEY"];

async function fixture(fn: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-codex-test-"));
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.MEDIA_LLM_TRANSPORT = "codex";
  process.env.CODEX_RUNS_DIR = root;
  delete process.env.MEDIA_LLM_PROVIDER;
  delete process.env.CODEX_BRIDGE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  resetLedger();
  try { await fn(root); }
  finally {
    mock.restoreAll();
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeCli(mode: "ok" | "limit" | "empty" | "timeout" = "ok", inspect?: (args: string[], options: any, prompt: string) => void | string) {
  return mock.method(childProcess, "spawn", (_bin: string, args: string[], options: any) => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit("close", 1)); return true; };
    let prompt = "";
    child.stdin.on("data", (chunk: Buffer) => { prompt += chunk.toString(); });
    child.stdin.on("finish", () => setImmediate(() => {
      const reply = inspect?.(args, options, prompt);
      if (mode === "timeout") return;
      if (mode === "limit") {
        child.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }) + "\n");
        child.emit("close", 1); return;
      }
      fs.writeFileSync(path.join(options.cwd, "answer.json"), JSON.stringify({ result: mode === "empty" ? "" : reply ?? '{"ok":true,"text":"Привет"}' }));
      const event = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 25 } });
      child.stdout.write(event.slice(0, 17)); child.stdout.write(event.slice(17) + "\n");
      child.emit("close", 0);
    }));
    return child;
  });
}

test("topic research fills evidence gaps once and forwards the original assignment and all arguments to the script", async () => fixture(async () => {
  process.env.BRAVE_API_KEY = "test-key";
  const topic = "Две лучшие камеры для путешествий в сентябре 2026 года";
  const queries: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q")!);
    const results = [{ title: "Camera specifications", url: "https://example.com/cameras", description: queries.length > 2 ? "Targeted weight evidence" : "Generic candidate data" }];
    return new Response(JSON.stringify(url.pathname.includes("news/") ? { results } : { web: { results } }));
  });
  let calls = 0;
  const cli = fakeCli("ok", (_args, _options, prompt) => {
    calls++;
    if (calls === 3) {
      assert.ok(prompt.includes(topic));
      assert.ok(prompt.includes("Выбрать две конкретные камеры"));
      assert.ok(prompt.includes("Аргумент кандидата 8"));
      return "Мой выбор — две камеры.";
    }
    if (calls === 2) {
      assert.ok(prompt.includes("Дополнительный поиск завершён"));
      assert.ok(prompt.includes("Targeted weight evidence"));
      assert.ok(!prompt.includes("Generic candidate data"));
    }
    return JSON.stringify({
      canonicalEvent: "Two travel cameras September 2026", kind: "PRODUCT",
      editorialBrief: "Выбрать две конкретные камеры и объяснить преимущества от лица автора.",
      entities: [{ name: "Camera A", type: "PRODUCT" }, { name: "Camera B", type: "PRODUCT" }],
      followUpQueries: ["Camera A weight", " Camera A weight ", "Camera B battery", "Camera A price", "ignored fourth query", null],
      facts: Array.from({ length: 8 }, (_, i) => ({ text: `Аргумент кандидата ${i + 1}`, sourceUrls: ["https://example.com/cameras"] })),
    });
  });
  const research = await buildStoryResearchPack(topic);
  assert.ok(research);
  assert.equal(research.facts.length, 8);
  assert.deepEqual(queries, [topic, topic, "Camera A weight", "Camera B battery", "Camera A price"]);
  assert.equal(cli.mock.callCount(), 2);
  const result = await generateScript(topic, research);
  assert.equal(result.script, "Мой выбор — две камеры.");
  assert.equal(result.demo, false);
}));

test("subscription runner does not inherit API keys, shell code or parent task identity", () => {
  const env = codexEnvironment({ PATH: "bin", USERPROFILE: "user", CODEX_HOME: "auth", OPENAI_API_KEY: "secret", CODEX_API_KEY: "secret", NODE_OPTIONS: "bad", CODEX_THREAD_ID: "parent" });
  assert.deepEqual(env, { PATH: "bin", USERPROFILE: "user", CODEX_HOME: "auth" });
  const args = codexArguments(request, "C:/temp/job", []);
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("read-only"));
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes(request.user));
});

test("real transport contract: UTF-8, final envelope, fragmented events and subscription accounting", async () => fixture(async root => {
  let workingDir = "";
  const cli = fakeCli("ok", (args, options, prompt) => {
    workingDir = options.cwd;
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(prompt.includes("Тест"));
    assert.ok(args.includes("gpt-6-astra"));
  });
  const text = await mediaComplete({ ...request, model: "claude-opus-5" });
  assert.deepEqual(JSON.parse(text), { ok: true, text: "Привет" });
  assert.equal(cli.mock.callCount(), 1);
  assert.equal(ledger()[0].provider, "codex");
  assert.equal(ledger()[0].inputTokens, 40);
  assert.equal(ledger()[0].cacheReadTokens, 80);
  assert.equal(ledger()[0].estimatedCost, 0);
  assert.equal(ledger()[0].providerReportedCost, undefined);
  assert.equal(ledger()[0].billing, "subscription");
  assert.deepEqual(summarize().unpricedModels, []);
  const logs = fs.readdirSync(path.join(root, "runs"));
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "runs", logs[0]), "utf8")).usage.inputTokens, 120);
  assert.ok(!fs.existsSync(workingDir));
  assert.ok(!fs.existsSync(path.join(root, "queue.lock")));
}));

test("no Anthropic key is required for scripts, and unknown provider config still fails", async () => fixture(async () => {
  fakeCli();
  assert.ok(mediaLlmAvailable());
  assert.equal((await generateScript("Проверка")).demo, false);
  process.env.MEDIA_LLM_PROVIDER = "anthropic";
  await assert.rejects(mediaComplete(request), /политики провайдеров/);
}));

test("quota failure is logged once and never retries through a paid API", async () => fixture(async root => {
  const cli = fakeCli("limit");
  const fetchSpy = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected paid API call"); });
  await assert.rejects(mediaComplete(request), /Лимит подписки Codex/);
  assert.equal(cli.mock.callCount(), 1);
  assert.equal(fetchSpy.mock.callCount(), 0);
  assert.equal(ledger()[0].failed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "runs", fs.readdirSync(path.join(root, "runs"))[0]), "utf8")).status, "failed");
}));

test("empty response and process timeout release queue and preserve a failed usage record", async () => fixture(async root => {
  fakeCli("empty");
  await assert.rejects(mediaComplete(request), /пустой результат/);
  mock.restoreAll();
  process.env.CODEX_TIMEOUT_MS = "1000";
  const cli = fakeCli("timeout");
  await assert.rejects(mediaComplete(request), /время ожидания/);
  assert.equal(cli.mock.callCount(), 1);
  assert.ok(!fs.existsSync(path.join(root, "queue.lock")));
  assert.equal(ledger().length, 2);
}));

test("images are attached as files in original order, without text-only degradation", async () => fixture(async () => {
  const frames = [Buffer.from([0xff, 0xd8, 0xff, 1]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])];
  fakeCli("ok", (args) => {
    const files = args.flatMap((arg, i) => arg === "--image" ? [args[i + 1]] : []);
    assert.deepEqual(files.map(file => fs.readFileSync(file)), frames);
  });
  await mediaVision({ ...request, images: frames.map(frame => ({ base64: frame.toString("base64"), mediaType: "image/jpeg" })) });
  await assert.rejects(mediaVision(request), /ни один кадр/);
}));

test("bridge queue serializes callers and releases after a rejected job", async () => fixture(async root => {
  let active = 0, maximum = 0;
  const work = () => withCodexQueue(root, 2000, async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active--;
  });
  await Promise.all([work(), work(), work()]);
  assert.equal(maximum, 1);
  await assert.rejects(withCodexQueue(root, 1000, async () => { throw new Error("failure"); }), /failure/);
  await work();
}));

test("Docker bridge transmits only the task and records the actual run", async () => fixture(async () => {
  process.env.CODEX_BRIDGE_TOKEN = "test-token";
  let failing = false;
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, "/complete");
    assert.equal(req.headers.authorization, "Bearer test-token");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, "gpt-6-astra");
    res.setHeader("Content-Type", "application/json");
    if (failing) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: "Лимит подписки Codex исчерпан", run: {
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, runId: "failed-remote", durationMs: 50,
      } }));
      return;
    }
    res.end(JSON.stringify({ text: "готово", usage: { inputTokens: 100, cacheReadTokens: 30, outputTokens: 15 }, runId: "remote", durationMs: 1000 }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.CODEX_BRIDGE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal(await mediaComplete(request), "готово");
    assert.equal(ledger()[0].runId, "remote");
    assert.equal(ledger()[0].inputTokens, 70);
    failing = true;
    await assert.rejects(mediaComplete(request), /Лимит подписки/);
    assert.equal(calls, 2);
    assert.equal(ledger()[1].failed, true);
    assert.equal(ledger()[1].runId, "failed-remote");
  } finally { server.close(); await once(server, "close"); }
}));

test("a timed-out queue waiter never runs or lets later jobs overlap the active job", async () => fixture(async root => {
  let release!: () => void;
  const active = withCodexQueue(root, 1000, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let ran = false;
  await assert.rejects(withCodexQueue(root, 10, async () => { ran = true; }), /Очередь/);
  const next = withCodexQueue(root, 1000, async () => { ran = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ran, false);
  release(); await active; await next;
  assert.equal(ran, true);
}));

test("engine fingerprints track model and effort; useful errors do not expose secrets", async () => fixture(async () => {
  const first = mediaEngine("AI Film Story");
  const old = process.env.CODEX_STORY_MODEL;
  try {
    process.env.CODEX_STORY_MODEL = "gpt-5.6-sol";
    assert.notDeepEqual(mediaEngine("AI Film Story"), first);
    assert.equal(codexModel("Metadata"), "gpt-5.6-luna");
  } finally { if (old === undefined) delete process.env.CODEX_STORY_MODEL; else process.env.CODEX_STORY_MODEL = old; }
  assert.match(codexError("401 secret").message, /codex login/);
  assert.ok(!codexError("oops secret").message.includes("secret"));
}));
