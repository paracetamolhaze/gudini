import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";
import { normalizeBible } from "../lib/aiFilm/story";
import { buildFilmPlan, shotKey } from "../lib/aiFilm/plan";
import { generateGroups } from "../lib/aiFilm/generate";
import { compositeFilter, overlaysFor } from "../lib/aiFilm/composite";
import { loadCharacterProfile } from "../lib/aiFilm/character";
import { loadUniverseProfile } from "../lib/aiFilm/universe";
import { ffmpegBin } from "../lib/ffmpeg";
import { resetLedger } from "../lib/costLedger";
import type { AiFilmPlan, CharacterProfile, StoryBeat } from "../lib/aiFilm/types";

/**
 * Приёмка сборки: план и сборщик видео обязаны понимать друг друга. Проверяется содержимое
 * итоговых файлов, а не только их длина и список идентификаторов — ровно там и пряталась
 * потеря первой сцены: два независимых запроса складывались в одну группу, второй исходник
 * подменял первый, длина сходилась, а первая сцена исчезала из ролика.
 *
 * Платных вызовов здесь нет: результаты Veo подменены настоящими локальными видео через
 * тот же кэш, которым пользуется генерация, а любое обращение в сеть считается ошибкой.
 */

const loaded = loadCharacterProfile();
const universe = loadUniverseProfile();
const character: CharacterProfile = { ...loaded, referenceFiles: [] };

const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function clip(file: string, colour: string, seconds: number): void {
  execFileSync(
    ffmpegBin(),
    ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${colour}:size=180x320:duration=${seconds}:rate=24`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

const beat = (id: string, start: number, end: number, location: string): StoryBeat => ({
  id, start, end, meaning: "", storyBeat: "", displayMode: "full_ai", purpose: "explain", priority: "high",
  requiresGeneration: true, gudiniVisible: false, universeAdaptation: "",
  visualAction: `A hand opens the ${id} parcel`, keyMoment: `the ${id} parcel opens`,
  anchorPhrase: "", anchorAtSec: null, anchorAbsSec: null, eventIds: [id.toLowerCase()],
  objects: [{ id: id.toLowerCase(), before: "sealed", after: "open" }],
  location, motion: "the lid lifts", stateBefore: "sealed", stateAfter: "open",
  continuityGroup: "shared", continuityRequired: true, transition: "cut", shotType: "medium",
  camera: "Camera is at eye level", cameraAngle: "eye_level", composition: "center", suggestedDuration: end - start,
});

function planOf(beats: StoryBeat[], duration: number): AiFilmPlan {
  const events = beats.map((b) => ({
    id: b.eventIds[0], observable: b.keyMoment, required: true, fromPhrase: 1, toPhrase: 1, objects: b.objects,
  }));
  const bible = normalizeBible({ bible: { storyType: "explainer", events } } as any, character, universe);
  return buildFilmPlan({
    character, bible, beats, duration,
    cfg: { key: "offline", universe, budgetUsd: 12, maxCoverage: 1, concurrency: 1, callMinutes: 2 },
  });
}

/** Кладёт в кэш готовые видео вместо ответов Veo — по тем же ключам, что считает сборщик. */
function seedCache(dir: string, plan: AiFilmPlan, colours: string[], lengths?: number[]): string[] {
  const cache: Record<string, unknown> = {};
  const files: string[] = [];
  for (const group of plan.groups) {
    let sourceKey: string | null = null;
    for (const id of group.shotIds) {
      const shot = plan.shots.find((s) => s.id === id)!;
      const key = shotKey(shot, character.refHash, sourceKey);
      const file = `scene-${files.length + 1}.mp4`;
      clip(path.join(dir, file), colours[files.length], lengths ? lengths[files.length] : shot.veoSeconds);
      cache[key] = {
        shotId: shot.id, key, gcsUri: `gs://offline/${file}`, file,
        operation: `offline-${files.length}`, veoSeconds: shot.veoSeconds, cost: shot.cost, createdAt: "offline",
      };
      files.push(file);
      sourceKey = key;
    }
  }
  fs.mkdirSync(path.join(dir, "ai-film"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-film", "shots.json"), JSON.stringify(cache), "utf8");
  return files;
}

function offline(t: any): () => number {
  let requests = 0;
  t.mock.method(GoogleAuth.prototype, "getClient", async () => ({ getAccessToken: async () => ({ token: "offline" }) }) as any);
  t.mock.method(globalThis, "fetch", async (url: any) => {
    requests++;
    throw new Error(`обращение в сеть в тесте сборки: ${String(url)}`);
  });
  return () => requests;
}

test("две независимые сцены доходят до ролика обе, каждая на своём месте", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-assembly-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  const requests = offline(t);

  // разные места действия: в один непрерывный кадр их не снять, значит это два запроса
  const plan = planOf([beat("B1", 0, 4, "a kitchen"), beat("B2", 4, 8, "a garden")], 8);
  assert.deepEqual(plan.issues, [], JSON.stringify(plan.issues));
  assert.equal(plan.shots.length, 2, JSON.stringify(plan.shots.map((s) => s.id)));
  assert.equal(plan.groups.length, 2, "независимый запрос обязан получить свою группу и свой отрезок");
  assert.deepEqual(plan.groups.map((g) => g.shotIds.length), [1, 1]);
  assert.deepEqual(plan.groups.map((g) => [g.start, g.end]), [[0, 4], [4, 8]]);

  const files = seedCache(dir, plan, ["red", "blue"]);
  const out = await generateGroups({ dir, projectId: "assembly", plan, character, concurrency: 1 });
  assert.equal(requests(), 0, "провайдер не должен вызываться: всё есть в кэше");
  assert.equal(out.clips.length, 2, "в ролик должны прийти обе сцены");

  // содержимое, а не длина: первая группа — именно первое видео, вторая — второе
  const byGroup = new Map(out.clips.map((c) => [c.groupId, path.join(dir, c.file)]));
  assert.equal(sha(byGroup.get(plan.groups[0].id)!), sha(path.join(dir, files[0])), "первая сцена потерялась");
  assert.equal(sha(byGroup.get(plan.groups[1].id)!), sha(path.join(dir, files[1])), "вторая сцена потерялась");
  assert.notEqual(sha(path.join(dir, files[0])), sha(path.join(dir, files[1])));

  // монтаж принимает план и ставит обе сцены на их отрезки
  const overlays = overlaysFor(plan, out.clips);
  assert.equal(overlays.length, 2);
  const filter = compositeFilter("null", overlays, plan, 1);
  assert.ok(filter.includes("between(t,0.000,4.000)"), filter);
  assert.ok(filter.includes("between(t,4.000,8.000)"), filter);
});

test("настоящая цепочка продолжения по-прежнему склеивается в одно видео", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-chain-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  const requests = offline(t);

  // одно место и один ракурс, но двенадцать секунд: это text + extend внутри одной группы
  const plan = planOf([beat("B1", 0, 8, "a kitchen"), beat("B2", 8, 12, "a kitchen")], 12);
  assert.equal(plan.groups.length, 1, JSON.stringify(plan.groups));
  assert.deepEqual(plan.shots.map((s) => s.mode), ["text", "extend"]);
  assert.equal(plan.shots[1].dependsOn, plan.shots[0].id);

  // продолжение вернуло только новые секунды — сборщик обязан склеить его с исходником
  const files = seedCache(dir, plan, ["red", "blue"], [8, 7]);
  const out = await generateGroups({ dir, projectId: "chain", plan, character, concurrency: 1 });
  assert.equal(requests(), 0);
  assert.equal(out.clips.length, 1, "цепочка остаётся одной группой");
  assert.ok(out.clips[0].seconds > 12, `склейка не произошла: ${out.clips[0].seconds} с`);
  assert.notEqual(sha(path.join(dir, out.clips[0].file)), sha(path.join(dir, files[1])), "итог не может быть только последним куском");
  assert.deepEqual(overlaysFor(plan, out.clips).length, 1);
});

test("исходник длиннее своего окна обрезается, а не занимает чужое время", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-trim-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  const requests = offline(t);

  const plan = planOf([beat("B1", 0, 4, "a kitchen"), beat("B2", 4, 8, "a garden")], 8);
  // Veo вернул по восемь секунд на каждый запрос, а в ролике у каждой сцены своё окно в 4 с
  const files = seedCache(dir, plan, ["red", "blue"], [8, 8]);
  const out = await generateGroups({ dir, projectId: "trim", plan, character, concurrency: 1 });
  assert.equal(requests(), 0);
  assert.equal(out.clips.length, 2);
  assert.ok(out.clips.every((c) => c.seconds > 7), "исходники остаются длинными");

  const byGroup = new Map(out.clips.map((c) => [c.groupId, path.join(dir, c.file)]));
  assert.equal(sha(byGroup.get(plan.groups[0].id)!), sha(path.join(dir, files[0])));
  assert.equal(sha(byGroup.get(plan.groups[1].id)!), sha(path.join(dir, files[1])));

  const filter = compositeFilter("null", overlaysFor(plan, out.clips), plan, 1);
  // каждая сцена обрезана до своих четырёх секунд и стоит на своём месте
  assert.equal(filter.split("trim=duration=4.000").length - 1, 2, filter);
  assert.ok(filter.includes("setpts=PTS-STARTPTS+0.000/TB"), filter);
  assert.ok(filter.includes("setpts=PTS-STARTPTS+4.000/TB"), filter);
});

test("после двух разделений третья сцена получает своё продолжение, а не обещание без материала", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-splits-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  const requests = offline(t);

  // три несовместимых места подряд, последнее длиннее одного клипа: 0–6, 6–12, 12–22
  const plan = planOf([beat("B1", 0, 6, "a kitchen"), beat("B2", 6, 12, "a garden"), beat("B3", 12, 22, "a hangar")], 22);
  assert.deepEqual(plan.issues.filter((i) => i.severity === "block"), [], JSON.stringify(plan.issues));
  assert.equal(plan.groups.length, 3, JSON.stringify(plan.groups.map((g) => [g.id, g.start, g.end, g.shotIds])));
  const last = plan.groups[2];
  assert.equal(last.shotIds.length, 2, "длинной сцене нужна цепочка, а не одно обещание на десять секунд");
  const covered = plan.shots.filter((s) => s.groupId === last.id).reduce((a, s) => a + s.usedSeconds, 0);
  assert.ok(covered + 0.3 >= last.end - last.start, `материала ${covered} с на окно ${last.end - last.start} с`);

  // и сборка это подтверждает: клип длиннее своего окна, монтаж принимает план
  const lengths = plan.shots.map((s) => (s.mode === "extend" ? s.veoSeconds : s.veoSeconds));
  seedCache(dir, plan, ["red", "blue", "green", "yellow"], lengths);
  const out = await generateGroups({ dir, projectId: "splits", plan, character, concurrency: 1 });
  assert.equal(requests(), 0);
  assert.equal(out.clips.length, 3);
  assert.equal(overlaysFor(plan, out.clips).length, 3);
});

test("смена места ровно на границе окна начинает новую сцену, а не продолжение", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-boundary-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  offline(t);

  // кухня ровно до восьмой секунды, дальше сад: раньше сад становился «тем же кадром»
  const plan = planOf([beat("B1", 0, 8, "a kitchen"), beat("B2", 8, 12, "a garden")], 12);
  assert.deepEqual(plan.shots.map((s) => s.mode), ["text", "text"], JSON.stringify(plan.shots.map((s) => [s.id, s.mode])));
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.shots[1].dependsOn, null);
  assert.ok(!plan.shots[1].prompt.includes("Continue the same shot"), plan.shots[1].prompt.slice(0, 200));
  assert.ok(plan.shots[1].prompt.includes("a garden"), plan.shots[1].prompt.slice(0, 300));
});

test("контактный лист принадлежит текущему видео, а не прошлому", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-sheet-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { contactSheet } = await import("../lib/aiFilm/generate");
  const video = path.join(dir, "group.mp4");
  const sheet = path.join(dir, "contact.jpg");

  clip(video, "red", 4);
  await contactSheet(video, sheet, 4);
  const first = sha(sheet);

  // тот же путь, другое видео: превью обязано пересобраться
  await new Promise((r) => setTimeout(r, 1100));
  clip(video, "blue", 4);
  await contactSheet(video, sheet, 4);
  assert.notEqual(sha(sheet), first, "показывался контактный лист от прошлой генерации");

  // без изменения видео лист не пересобирается
  const second = sha(sheet);
  await contactSheet(video, sheet, 4);
  assert.equal(sha(sheet), second);
});
