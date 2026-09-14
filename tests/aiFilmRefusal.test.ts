import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { generateShot, generateGroups } from "../lib/aiFilm/generate";
import { shotKey } from "../lib/aiFilm/plan";
import { ledger, resetLedger } from "../lib/costLedger";
import type { FilmShot } from "../lib/aiFilm/types";

const shot = { id: "G1-1", prompt: "A quiet room", model: "veo-test", mode: "text", veoSeconds: 8, aspectRatio: "9:16", resolution: "720p", cost: 0.64, useReferences: false } as FilmShot;

test("provider refusal preserves its full reason, settles the exact call, and cannot be retried", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-refusal-"));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  t.mock.method(GoogleAuth.prototype, "getClient", async () => ({ getAccessToken: async () => ({ token: "test" }) }) as any);
  let calls = 0;
  const reason = "Veo refused this request. You will not be charged for this request. " + "details ".repeat(40) + "Support codes: 42237218";
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(calls === 1 ? { name: "operation-test" } : { done: true, response: { raiMediaFilteredReasons: [reason], raiMediaFilteredCount: 1 } });
  });
  const args = { dir, projectId: "test", shot, key: "same-key", references: [], plan: {} as any };
  await assert.rejects(generateShot(args), /42237218/);
  assert.equal(calls, 2);
  assert.equal(ledger().length, 1);
  assert.equal(ledger()[0].estimatedCost, 0);
  assert.equal(ledger()[0].providerReportedCost, 0);
  assert.equal(ledger()[0].failed, true);
  resetLedger();
  await assert.rejects(generateShot(args), /уже отклонена/);
  assert.equal(calls, 2, "cached refusal must not call Google again");
  assert.equal(ledger().length, 0);
});

test("a legacy refusal in any group stops the entire plan before new requests", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-refusal-plan-"));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const refused = { ...shot, id: "G2-1" };
  const key = shotKey(refused, "refs", null);
  fs.mkdirSync(path.join(dir, "ai-film", "raw"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-film", "raw", `${refused.id}-${key}.json`), JSON.stringify({ key, terminalError: true, operation: "old", error: "Veo: результат без видео (фильтр безопасности: refused)" }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  await assert.rejects(generateGroups({ dir, projectId: "test", character: { refHash: "refs" } as any, concurrency: 3,
    plan: { shots: [shot, refused], groups: [{ id: "G1", shotIds: [shot.id] }, { id: "G2", shotIds: [refused.id] }] } as any,
  }), /уже отклонена/);
  assert.equal(calls, 0);
});
