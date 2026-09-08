import test from "node:test";
import assert from "node:assert/strict";
import { compositeFilter, audioFilter, overlaysFor, FILM_W, FILM_H } from "../lib/aiFilm/composite";
import { motionStats } from "../lib/aiFilm/check";
import { veoBody, VEO_REFERENCE_SECONDS } from "../lib/aiFilm/veo";
import { buildFilmPlan, shotKey } from "../lib/aiFilm/plan";
import { normalizeBible } from "../lib/aiFilm/story";
import { veoPricePerSecond } from "../lib/aiFilm/pricing";
import { setRunCostLimit, assertBudget, resetLedger, recordFlat } from "../lib/costLedger";
import { isAllowed } from "../lib/providerPolicy";
import { CARD } from "../lib/topInset";
import { gudini, beat, universe } from "./aiFilmPlan.test";

const withRefs = { ...gudini, referenceFiles: ["/tmp/gudini/ref-1.png"] };
const bible = normalizeBible({}, gudini, universe);
const cfg = { key: "k", universe, budgetUsd: 12, maxCoverage: 0.55, concurrency: 3, callMinutes: 2 };

const plan120 = () =>
  buildFilmPlan({
    character: withRefs, bible, duration: 120, cfg,
    beats: [
      beat("B1", 0, 6, "full_ai", { purpose: "hook", priority: "high" }),
      beat("B2", 6, 17, "author"),
      beat("B3", 17, 24, "hybrid"),
      beat("B4", 24, 38, "author"),
      beat("B5", 38, 46, "full_ai", { purpose: "reveal", priority: "high" }),
      beat("B6", 46, 120, "author"),
    ],
  });

test("K: голос автора — одна непрерывная дорожка независимо от AUTHOR → FULL_AI → AUTHOR", () => {
  const plan = plan120();
  const clips = plan.groups.map((g) => ({ groupId: g.id, file: `ai-film/group-${g.id}.mp4`, seconds: 8 }));
  const video = compositeFilter("scale=1080:1920,setsar=1", overlaysFor(plan, clips), plan, 1);
  const audio = audioFilter(false);
  assert.equal(audio, "[0:a]afftdn=nr=10:nf=-45:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]");
  assert.doesNotMatch(video, /\[\d+:a\]|atrim|asetpts|amix/);
  assert.equal((video.match(/\[0:v\]/g) ?? []).length, 1, "автор берётся один раз целиком");
  // три окна: full_ai 0–6, hybrid 17–24, full_ai 38–46 — жёсткие склейки через enable
  assert.match(video, /enable='between\(t,0\.000,6\.000\)'/);
  assert.match(video, /enable='between\(t,17\.000,24\.000\)'/);
  assert.match(video, /enable='between\(t,38\.000,46\.000\)'/);
  assert.match(video, /setpts=PTS-STARTPTS\+38\.000\/TB/);
});

test("L: FULL_AI занимает весь кадр 9:16, HYBRID — карточку сверху", () => {
  const plan = plan120();
  assert.equal(FILM_W, 1080);
  assert.equal(FILM_H, 1920);
  assert.ok(plan.shots.filter((s) => s.displayMode === "full_ai").every((s) => s.aspectRatio === "9:16"));
  assert.ok(plan.shots.filter((s) => s.displayMode === "hybrid").every((s) => s.aspectRatio === "16:9"));
  const clips = plan.groups.map((g) => ({ groupId: g.id, file: `ai-film/group-${g.id}.mp4`, seconds: 8 }));
  const video = compositeFilter("scale=1080:1920,setsar=1", overlaysFor(plan, clips), plan, 1);
  assert.match(video, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[^;]*\[ai0\];\[vbase\]\[ai0\]overlay=0:0/);
  assert.match(video, new RegExp(`overlay=${CARD.x}:${CARD.y}`));
});

test("M: субтитры — верхний слой и на авторе, и на AI", () => {
  const plan = plan120();
  const clips = plan.groups.map((g) => ({ groupId: g.id, file: `x-${g.id}.mp4`, seconds: 8 }));
  const video = compositeFilter("scale=1080:1920,setsar=1", overlaysFor(plan, clips), plan, 1);
  assert.match(video, /;\[vo2\]ass=subs\.ass\[v\]$/);
});

test("клип короче своего окна — ошибка сборки, а не тихая заморозка", () => {
  const plan = plan120();
  const clips = plan.groups.map((g) => ({ groupId: g.id, file: `x-${g.id}.mp4`, seconds: g.id === "G2" ? 4 : 8 }));
  assert.throws(() => overlaysFor(plan, clips), /короче своего отрезка/);
});

test("N: смена одного независимого shot не меняет ключи остальных", () => {
  const plan = plan120();
  const [a, b, c] = plan.shots;
  const kb = shotKey(b, "refs-a", null);
  const kc = shotKey(c, "refs-a", null);
  const changed = { ...a, prompt: a.prompt + " Now he smiles." };
  assert.notEqual(shotKey(changed, "refs-a", null), shotKey(a, "refs-a", null));
  assert.equal(shotKey(b, "refs-a", null), kb);
  assert.equal(shotKey(c, "refs-a", null), kc);
});

test("тело запроса Veo: референсы как ASSET, только с 8 с и без image/video; 9:16; без звука", () => {
  const refs = [{ gcsUri: "gs://b/characters/gudini/a.png", mimeType: "image/png" }];
  const body = veoBody({ model: "m", prompt: "p", durationSeconds: VEO_REFERENCE_SECONDS, storageUri: "gs://b/x/", aspectRatio: "9:16", referenceImages: refs });
  assert.deepEqual(body.instances[0].referenceImages, [{ image: { gcsUri: "gs://b/characters/gudini/a.png", mimeType: "image/png" }, referenceType: "ASSET" }]);
  assert.equal(body.parameters.aspectRatio, "9:16");
  assert.equal(body.parameters.generateAudio, false);
  assert.equal(body.parameters.resolution, "720p");
  assert.throws(() => veoBody({ model: "m", prompt: "p", durationSeconds: 6, storageUri: "gs://b/x/", aspectRatio: "9:16", referenceImages: refs }), /8 с/);
  assert.throws(() => veoBody({ model: "m", prompt: "p", durationSeconds: 8, storageUri: "gs://b/x/", aspectRatio: "9:16", referenceImages: refs, videoGcsUri: "gs://b/v.mp4" }), /не сочетаются/);
  assert.throws(() => veoBody({ model: "m", prompt: "p", durationSeconds: 5, storageUri: "gs://b/x/", aspectRatio: "16:9" }), /не поддерживается/);
  const ext = veoBody({ model: "m", prompt: "p", durationSeconds: 7, storageUri: "gs://b/x/", aspectRatio: "9:16", videoGcsUri: "gs://b/prev.mp4" });
  assert.deepEqual(ext.instances[0].video, { gcsUri: "gs://b/prev.mp4", mimeType: "video/mp4" });
  assert.equal(ext.instances[0].referenceImages, undefined);
});

test("цены Veo: политика по модели/звуку/разрешению, ручной override, неизвестная модель — ошибка", () => {
  const prev = process.env.AI_FILM_PRICE_PER_SEC;
  delete process.env.AI_FILM_PRICE_PER_SEC;
  try {
    assert.deepEqual(veoPricePerSecond("veo-3.1-fast-generate-001", { audio: false, resolution: "720p" }), { pricePerSec: 0.08, source: "policy" });
    assert.equal(veoPricePerSecond("veo-3.1-fast-generate-001", { audio: true, resolution: "720p" }).pricePerSec, 0.1);
    assert.equal(veoPricePerSecond("veo-3.1-lite-generate-001", { audio: false, resolution: "720p" }).pricePerSec, 0.03);
    assert.throws(() => veoPricePerSecond("veo-9-unknown", { audio: false, resolution: "720p" }), /не в таблице цен/);
    process.env.AI_FILM_PRICE_PER_SEC = "0.05";
    assert.deepEqual(veoPricePerSecond("veo-9-unknown", { audio: false, resolution: "720p" }), { pricePerSec: 0.05, source: "env" });
  } finally {
    if (prev === undefined) delete process.env.AI_FILM_PRICE_PER_SEC; else process.env.AI_FILM_PRICE_PER_SEC = prev;
  }
});

test("проверка жизни AI-окна: движущиеся кадры проходят, застывшие и чёрные — нет", () => {
  const size = 16 * 9;
  const moving = Buffer.alloc(size * 6);
  for (let f = 0; f < 6; f++) for (let i = 0; i < size; i++) moving[f * size + i] = (i * 7 + f * 40) % 256;
  const m = motionStats(moving);
  assert.equal(m.frames, 6);
  assert.equal(m.changed, 5);
  assert.equal(motionStats(Buffer.alloc(size * 6, 120)).changed, 0);
  assert.equal(motionStats(Buffer.alloc(size * 6, 3)).dark, 6);
});

test("политика провайдеров: история — Anthropic, генерация — только Google", () => {
  assert.ok(isAllowed("AI Film Story", "anthropic"));
  assert.ok(isAllowed("AI Film Generation", "google"));
  assert.ok(!isAllowed("AI Film Generation", "anthropic"));
  assert.ok(!isAllowed("Cover Generation", "google"));
});

test("предел запуска фильма заменяет предел $2 на время генерации и сбрасывается", () => {
  resetLedger();
  const prevHard = process.env.MEDIA_JOB_HARD_LIMIT;
  const prevMax = process.env.MEDIA_JOB_MAX_COST_USD;
  process.env.MEDIA_JOB_HARD_LIMIT = "1";
  process.env.MEDIA_JOB_MAX_COST_USD = "2";
  try {
    recordFlat({ stage: "AI Film Generation", provider: "google", model: "veo", cost: 5 });
    assert.throws(() => assertBudget("AI Film Generation", 1.05), /Лимит расходов/);
    setRunCostLimit(12);
    assertBudget("AI Film Generation", 1.05);
    assert.throws(() => assertBudget("AI Film Generation", 7.5), /Лимит расходов/);
    resetLedger();
    recordFlat({ stage: "AI Film Generation", provider: "google", model: "veo", cost: 5 });
    assert.throws(() => assertBudget("AI Film Generation", 1.05), /Лимит расходов/);
  } finally {
    if (prevHard === undefined) delete process.env.MEDIA_JOB_HARD_LIMIT; else process.env.MEDIA_JOB_HARD_LIMIT = prevHard;
    if (prevMax === undefined) delete process.env.MEDIA_JOB_MAX_COST_USD; else process.env.MEDIA_JOB_MAX_COST_USD = prevMax;
    resetLedger();
  }
});
