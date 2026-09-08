import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Project } from "../lib/store";
import type { AiFilmState } from "../lib/aiFilm/types";

const originalCwd = process.cwd();
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-style-lifecycle-"));
let store: typeof import("../lib/store");
let complete: typeof import("../app/api/worker/complete/[id]/route");
let delivery: typeof import("../lib/deliveryMarker");

before(async () => {
  // store and workerState bind their data directories at import time.
  // Import only after switching to an isolated directory: never touch user data.
  process.chdir(testDir);
  store = await import("../lib/store");
  complete = await import("../app/api/worker/complete/[id]/route");
  delivery = await import("../lib/deliveryMarker");
});

after(async () => {
  process.chdir(originalCwd);
  const resolved = path.resolve(testDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("gudini-style-lifecycle-"));
  await fs.promises.rm(path.join(resolved, "data"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    await fs.promises.rmdir(resolved);
  } catch (error) {
    // Windows may retain the loader's handle to the temporary cwd until exit.
    // Its data has been removed; only an empty, OS-temporary directory may remain.
    assert.ok(["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
    assert.deepEqual(fs.readdirSync(resolved), []);
  }
});

const plan = {
  key: "approved-plan",
  stats: { estimatedCost: 1.2, aiSeconds: 8, speechSeconds: 20 },
} as NonNullable<AiFilmState["plan"]>;

function project(patch: Partial<Project> = {}): Project {
  return {
    id: "style-lifecycle",
    topic: "Проверка стиля",
    createdAt: "2026-09-08T00:00:00Z",
    script: "Один и тот же сценарий",
    rawVideo: "raw.mp4",
    processedVideo: null,
    processing: { state: "running", step: "Монтаж на воркере", progress: 90 },
    meta: null,
    publications: [],
    ...patch,
  };
}

async function finish(p: Project, body: Record<string, unknown>, hasVideo: boolean) {
  store.upsertProject(p);
  const out = path.join(store.projectDir(p.id), "out.mp4");
  if (hasVideo) fs.writeFileSync(out, "completed worker video");
  else fs.rmSync(out, { force: true });
  const response = await complete.POST(new NextRequest(`http://localhost/api/worker/complete/${p.id}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }), { params: Promise.resolve({ id: p.id }) });
  return { response, body: await response.json() };
}

test("готовый AI-план → cards: воркер доставляет MP4, старый план не перехватывает завершение", async () => {
  const aiFilm: AiFilmState = { request: "plan", status: "planned", plan };
  const result = await finish(project({ montageStyle: "cards", aiFilm }), { aiFilm, brollCount: 3 }, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processing.state, "done");
  assert.equal(result.body.processedVideo, "out.mp4");
  assert.equal(result.body.brollCount, 3);
});

test("готовый AI-фильм → новый план: старые generatedAt и MP4 не выдают план за сгенерированный фильм", async () => {
  const aiFilm: AiFilmState = {
    request: "plan", status: "planned", plan,
    generatedAt: "2026-09-07T10:00:00Z", spent: 5,
  };
  const result = await finish(project({ montageStyle: "ai_film", aiFilm, processedVideo: "out.mp4" }), { aiFilm }, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processing.state, "idle");
  assert.equal(result.body.processedVideo, null);
  assert.equal(result.body.aiFilm.status, "planned");
  assert.equal(result.body.aiFilm.generatedAt, undefined);
  assert.equal(result.body.aiFilm.spent, undefined);
});

test("готовый cards → AI-план: план принимается без нового MP4 и снимает старый результат", async () => {
  const aiFilm: AiFilmState = { request: "plan", status: "planned", plan };
  const result = await finish(project({ montageStyle: "ai_film", processedVideo: "out.mp4" }), { aiFilm }, false);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processing.state, "idle");
  assert.equal(result.body.processedVideo, null);
  assert.equal(result.body.aiFilm.plan.key, "approved-plan");
});

test("первый стиль по умолчанию: обычный результат без AI-метаданных становится готовым MP4", async () => {
  const result = await finish(project(), { brollCount: 4, subtitlesSource: "scribe" }, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processing.state, "done");
  assert.equal(result.body.processedVideo, "out.mp4");
  assert.equal(result.body.brollCount, 4);
  assert.equal(result.body.subtitlesSource, "scribe");
});

test("готовый AI-фильм принимается как MP4 и сохраняет результат генерации", async () => {
  const aiFilm: AiFilmState = { request: "generate", status: "generated", plan, generatedAt: "2026-09-08T00:00:00Z", spent: 1.2 };
  const result = await finish(project({ montageStyle: "ai_film" }), { aiFilm }, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processing.state, "done");
  assert.equal(result.body.processedVideo, "out.mp4");
  assert.equal(result.body.aiFilm.status, "generated");
  assert.equal(result.body.aiFilm.spent, 1.2);
});

test("cards с сохранённым AI-планом не завершается без загруженного MP4", async () => {
  const aiFilm: AiFilmState = { request: "plan", status: "planned", plan };
  const result = await finish(project({ montageStyle: "cards", aiFilm }), { aiFilm }, false);
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, "out.mp4 не загружен");
});

test("недоставленный cards → запрос AI generation: тот же исходник не разрешает дослать ролик другого стиля", () => {
  const marker = {
    at: "2026-09-08T00:00:00Z", rawFingerprint: "same-raw", scriptHash: "same-script",
    montageStyle: "cards" as const, project: { processedVideo: "out.mp4" },
  };
  const request = { rawFingerprint: "same-raw", scriptHash: "same-script", montageStyle: "ai_film" as const };
  assert.equal(delivery.canRedeliver(marker, request), false);
});

test("недоставленный AI-фильм → изменённый план: старый фильм не заменяет новую генерацию", () => {
  const marker = {
    at: "2026-09-08T00:00:00Z", rawFingerprint: "same-raw", scriptHash: "same-script",
    montageStyle: "ai_film" as const, aiFilmPlanHash: "first-approved-plan", project: { processedVideo: "out.mp4" },
  };
  const request = {
    rawFingerprint: "same-raw", scriptHash: "same-script", montageStyle: "ai_film" as const,
    aiFilmPlanHash: "new-approved-plan",
  };
  assert.equal(delivery.canRedeliver(marker, request), false);
});

test("сбой доставки при прежнем стиле и плане допускает досылку обоих стилей без повторного монтажа", () => {
  const fingerprint = { rawFingerprint: "same-raw", scriptHash: "same-script" };
  const cards = { at: "2026-09-08T00:00:00Z", ...fingerprint, montageStyle: "cards" as const, project: {} };
  assert.equal(delivery.canRedeliver(cards, { ...fingerprint, montageStyle: "cards" }), true);
  const aiFilm = { ...cards, montageStyle: "ai_film" as const, aiFilmPlanHash: "approved-plan" };
  assert.equal(delivery.canRedeliver(aiFilm, { ...fingerprint, montageStyle: "ai_film", aiFilmPlanHash: "approved-plan" }), true);
  assert.equal(delivery.canRedeliver(aiFilm, { ...fingerprint, montageStyle: "cards" }), false);
});

test("итог каждого стиля хранится отдельно: out-<style>.mp4 и outputs в проекте", async () => {
  const generated: AiFilmState = { request: "generate", status: "generated", plan, generatedAt: "2026-09-08T01:00:00Z", spent: 1.2 };
  const first = await finish(project({ montageStyle: "ai_film", aiFilm: generated }), { montageStyle: "ai_film", aiFilm: generated, subtitlesSource: "scribe" }, true);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.processedVideo, "out.mp4");
  assert.equal(first.body.outputs.ai_film.file, "out-ai_film.mp4");
  assert.equal(first.body.outputs.ai_film.subtitlesSource, "scribe");
  assert.ok(fs.existsSync(path.join(store.projectDir("style-lifecycle"), "out-ai_film.mp4")));
  const second = await finish({ ...first.body, montageStyle: "cards", processing: { state: "running", step: "Монтаж на воркере", progress: 90 } }, { montageStyle: "cards", brollCount: 2 }, true);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.outputs.ai_film.file, "out-ai_film.mp4", "итог AI-фильма не стёрт монтажом карточек");
  assert.equal(second.body.outputs.cards.file, "out-cards.mp4");
  assert.equal(second.body.outputs.cards.brollCount, 2);
  assert.ok(fs.existsSync(path.join(store.projectDir("style-lifecycle"), "out-cards.mp4")));
});
