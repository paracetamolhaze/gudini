import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverJobs, type TikTokState, type TikTokJob } from "../lib/tiktok/state";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function job(submitted: boolean): TikTokJob {
  return { id: "1", key: "k", account: "a", projectId: "p", caption: "Caption", video: "/video.mp4", scheduledAt: new Date().toISOString(), status: "running", message: "", at: "", submitted };
}
test("restart never retries a post whose submit may already have reached TikTok", () => {
  const state: TikTokState = { connected: true, autoPublish: false, seen: [], jobs: [job(true)] };
  recoverJobs(state);
  assert.equal(state.jobs[0].status, "unknown");
  recoverJobs(state);
  assert.equal(state.jobs[0].status, "unknown");
});
test("restart resumes only work that has not clicked Post", () => {
  const state: TikTokState = { connected: true, autoPublish: false, seen: [], jobs: [job(false)] };
  recoverJobs(state);
  assert.equal(state.jobs[0].status, "queued");
});
test("restart preserves completed, blocked and scheduled jobs", () => {
  const statuses = ["published", "queued", "needs_login", "unknown", "cancelled", "error"] as const;
  const state: TikTokState = { connected: false, autoPublish: false, seen: [], jobs: statuses.map(status => ({ ...job(false), status })) };
  recoverJobs(state);
  assert.deepEqual(state.jobs.map(j => j.status), statuses);
});

test("real worker persists immutable jobs, deduplicates, protects access and retains actionable history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-tiktok-test-"));
  const projectDir = path.join(root, "data", "uploads", "p");
  const stateDir = path.join(root, "data", "tiktok-browser");
  fs.mkdirSync(projectDir, { recursive: true }); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(projectDir, "out.mp4"), "original video bytes");
  const project = { id: "p", topic: "Test", createdAt: "", processedVideo: "out.mp4", processing: { state: "done" }, publications: [], meta: { title: "Title", description: "Description", hashtags: ["#tag"] } };
  fs.writeFileSync(path.join(root, "data", "db.json"), JSON.stringify({ projects: [project] }));
  const oldUnknown = { ...job(true), id: "old-unknown", status: "unknown", key: "old" };
  const history = Array.from({ length: 35 }, (_, i) => ({ ...job(true), id: `done-${i}`, status: "published" }));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ connected: true, account: "a", autoPublish: false, seen: [], jobs: [oldUnknown, ...history], loginRetryAfter: "2099-01-01T00:00:00Z", loginIssue: "TikTok: слишком много попыток" }));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("worker/tiktok.ts")], {
    cwd: root, env: { ...process.env, TIKTOK_TRANSPORT: "browser", TIKTOK_BROWSER_HOST: "127.0.0.1", TIKTOK_BROWSER_PORT: "0", TIKTOK_BROWSER_TOKEN: "test-secret" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${stderr}`)), 20_000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Worker exited: ${stderr}`)); });
      child.stdout.on("data", chunk => { const match = String(chunk).match(/запущен: (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    const request = async (action: string, body?: unknown, auth = "test-secret") => {
      const response = await fetch(`http://127.0.0.1:${port}/${action}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { code: response.status, data: await response.json() };
    };
    assert.equal((await request("status", undefined, "wrong")).code, 401);
    assert.equal((await request("login", {})).code, 400, "persisted cooldown must reject login before launching a browser");
    assert.equal((await request("status")).data.loginRetryAfter, "2099-01-01T00:00:00Z");
    assert.ok((await request("status")).data.jobs.some((j: TikTokJob) => j.id === "old-unknown"));
    assert.equal((await request("enqueue", { projectId: "p", style: "ai_film" })).code, 400, "missing selected version must not fall back to a different video");
    assert.equal((await request("enqueue", { projectId: "p", scheduledAt: "invalid" })).code, 400);
    const first = await request("enqueue", { projectId: "p", scheduledAt: "2099-01-01T00:00:00Z" });
    assert.equal(first.code, 200);
    const second = await request("enqueue", { projectId: "p", scheduledAt: "2099-02-01T00:00:00Z" });
    assert.equal(second.data.job.id, first.data.job.id, "repeated requests must reuse the same job");
    fs.writeFileSync(path.join(projectDir, "out.mp4"), "changed video bytes");
    const saved: TikTokState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const stored = saved.jobs.at(-1)!;
    assert.equal(fs.readFileSync(stored.video, "utf8"), "original video bytes", "rerender must not change scheduled content");
    assert.equal(stored.caption, "Title\n\nDescription\n\n#tag");
    assert.equal((await request("cancel", { id: "old-unknown" })).code, 400, "ambiguous submissions require explicit resolution");
    assert.equal((await request("resolve", { id: "old-unknown", result: "published" })).code, 200);
    assert.equal((await request("cancel", { id: stored.id })).code, 200);
    await request("settings", { autoPublish: true });
    const enabled: TikTokState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(enabled.seen.length, 1, "enabling automatic mode must baseline pre-existing completed videos");
    const view = (await request("status")).data;
    assert.ok(view.jobs.every((j: Record<string, unknown>) => !j.video && !j.cover && !j.key && !j.account), "status must not expose internal paths or account identifiers");
  } finally {
    child.kill(); await exited;
    // Test-created directory only, validated before recursive cleanup.
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gudini-tiktok-test-")) throw new Error("Invalid test cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
