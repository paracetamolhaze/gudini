import test from "node:test";
import assert from "node:assert/strict";
import { compositeFilter, authorCropY, FILM_H, AUTHOR_H } from "../lib/aiFilm/composite";
import { motionStats } from "../lib/aiFilm/check";
import { veoBody } from "../lib/aiFilm/veo";
import { setRunCostLimit, assertBudget, resetLedger, recordFlat } from "../lib/costLedger";
import { isAllowed } from "../lib/providerPolicy";

test("геометрия: фильм 1080×608 сверху, автор 1312 снизу, субтитры поверх", () => {
  assert.equal(FILM_H + AUTHOR_H, 1920);
  const f = compositeFilter("scale=1080:1920,setsar=1", 61.5, 200);
  assert.match(f, /crop=1080:1312:0:200\[author\]/);
  assert.match(f, /scale=1080:608/);
  assert.match(f, /trim=duration=61\.500/);
  assert.match(f, /\[film\]\[author\]vstack=inputs=2,ass=subs\.ass\[v\]/);
  assert.ok(authorCropY() >= 0 && authorCropY() <= 1920 - AUTHOR_H);
});

test("проверка жизни верха: движущиеся кадры проходят, застывшие и чёрные — нет", () => {
  const size = 16 * 9;
  const moving = Buffer.alloc(size * 6);
  for (let f = 0; f < 6; f++) for (let i = 0; i < size; i++) moving[f * size + i] = (i * 7 + f * 40) % 256;
  const m = motionStats(moving);
  assert.equal(m.frames, 6);
  assert.equal(m.changed, 5);
  assert.equal(m.dark, 0);
  const frozen = Buffer.alloc(size * 6, 120);
  assert.equal(motionStats(frozen).changed, 0);
  const black = Buffer.alloc(size * 6, 3);
  assert.equal(motionStats(black).dark, 6);
});

test("тело запроса Veo: без звука, 16:9, 720p; extension — видео из GCS, не автора", () => {
  const b = veoBody({ model: "m", prompt: "p", durationSeconds: 7, storageUri: "gs://b/x/", videoGcsUri: "gs://b/prev.mp4" });
  assert.equal(b.parameters.generateAudio, false);
  assert.equal(b.parameters.aspectRatio, "16:9");
  assert.equal(b.parameters.resolution, "720p");
  assert.equal(b.parameters.durationSeconds, 7);
  assert.deepEqual(b.instances[0].video, { gcsUri: "gs://b/prev.mp4", mimeType: "video/mp4" });
  assert.equal(b.instances[0].image, undefined);
  const img = veoBody({ model: "m", prompt: "p", durationSeconds: 8, storageUri: "gs://b/x/", imageGcsUri: "gs://b/f.jpg" });
  assert.equal(img.instances[0].image.mimeType, "image/jpeg");
});

test("политика провайдеров: история — Anthropic, генерация — только Google", () => {
  assert.ok(isAllowed("AI Film Story", "anthropic"));
  assert.ok(isAllowed("AI Film Generation", "google"));
  assert.ok(!isAllowed("AI Film Generation", "anthropic"));
  assert.ok(!isAllowed("AI Film Story", "google"));
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
    assert.throws(() => assertBudget("AI Film Generation", 1.05), /Лимит расходов/, "после сброса предел снова обычный");
  } finally {
    if (prevHard === undefined) delete process.env.MEDIA_JOB_HARD_LIMIT; else process.env.MEDIA_JOB_HARD_LIMIT = prevHard;
    if (prevMax === undefined) delete process.env.MEDIA_JOB_MAX_COST_USD; else process.env.MEDIA_JOB_MAX_COST_USD = prevMax;
    resetLedger();
  }
});
