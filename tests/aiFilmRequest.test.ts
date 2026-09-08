import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-film-request-"));
let store: typeof import("../lib/store");
let processRoute: typeof import("../app/api/projects/[id]/process/route");
let projectRoute: typeof import("../app/api/projects/[id]/route");
let film: typeof import("../lib/aiFilm/run");

before(async () => {
  process.chdir(dir);
  store = await import("../lib/store");
  assert.equal(store.UPLOADS_DIR, path.join(dir, "data", "uploads"));
  processRoute = await import("../app/api/projects/[id]/process/route");
  projectRoute = await import("../app/api/projects/[id]/route");
  film = await import("../lib/aiFilm/run");
});

after(async () => {
  process.chdir(root);
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  await fs.promises.rm(path.join(dir, "data"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    await fs.promises.rmdir(dir);
  } catch (error) {
    if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
});

test("повторный process не меняет фазу AI-фильма уже работающего задания", async () => {
  const p = store.createProject("film request test");
  store.updateProject(p.id, {
    rawVideo: "raw.mp4", montageStyle: "ai_film",
    aiFilm: { request: "generate", status: "planned", plan: {} as any },
    processing: { state: "running", step: "Генерация сцен", progress: 30 },
  });
  const response = await processRoute.POST(new NextRequest(`http://localhost/api/projects/${p.id}/process`, {
    method: "POST", body: JSON.stringify({ request: "plan" }),
  }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(response.status, 200);
  assert.equal(store.getProject(p.id)?.aiFilm?.request, "generate");
});

test("смена стиля работающего задания отклоняется, выбранный стиль сохраняется", async () => {
  const p = store.createProject("style request test");
  store.updateProject(p.id, {
    montageStyle: "cards", processing: { state: "running", step: "Монтаж", progress: 40 },
  });
  const response = await projectRoute.PATCH(new NextRequest(`http://localhost/api/projects/${p.id}`, {
    method: "PATCH", body: JSON.stringify({ montageStyle: "ai_film" }),
  }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(response.status, 409);
  assert.equal(store.getProject(p.id)?.montageStyle, "cards");
});

test("план AI-фильма устаревает при изменении таймкодов той же речи", () => {
  const words = [{ word: "Привет", start: 0, end: 0.8 }, { word: "мир", start: 1, end: 1.5 }];
  const character = { id: "gudini", refHash: "refs" };
  const universe = { id: "world", hash: "world-hash" };
  const key = film.planKey(words, "Привет мир", character, universe);
  assert.equal(key, film.planKey(words.map(w => ({ ...w })), "Привет мир", character, universe));
  assert.notEqual(key, film.planKey(words.map(w => ({ ...w, start: w.start + 1, end: w.end + 1 })), "Привет мир", character, universe));
  assert.notEqual(key, film.planKey(words, "Привет мир", character, universe, 3));
});
