import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runFfmpeg } from "../lib/ffmpeg";
import { renderPlan } from "../lib/pipeline";
import { checkRenderConformance, checkPointsFor } from "../lib/renderConformance";
import { frameHash, hamming } from "../lib/sceneHash";
import { DEFAULT_CAPTION_STYLE, EditPlan } from "../lib/editPlan";
import { segmentWindowDecision, SEGMENT_WINDOW, WINDOW_OFFSETS } from "../lib/storyAssetPack";
import { packDistribution, montagePreflight } from "../lib/montageValidator";

/**
 * Регрессия на НАСТОЯЩЕМ рендере, покадрово. Неподвижная картинка обязана быть
 * на экране всю запланированную длительность: раньше она показывалась 1/30
 * секунды, потому что JPEG — это один кадр, и без зацикливания overlay сразу
 * пропускал A-roll. Всё локально, без единого API-вызова.
 */

const LAYOUT = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";

async function fixture(dir: string) {
  // A-roll со звуком и заметно другая картинка-вставка; обе со структурой,
  // потому что перцептивный хэш сравнивает рисунок кадра, а не среднюю яркость
  await runFfmpeg([
    "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=5:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    path.join(dir, "aroll.mp4"),
  ]);
  await runFfmpeg(["-f", "lavfi", "-i", "smptebars=s=1080x1920", "-frames:v", "1", path.join(dir, "still.png")]);
  fs.writeFileSync(
    path.join(dir, "subs.ass"),
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
  );
}

/** Хэш кадра готового ролика в заданной секунде. */
async function outHash(dir: string, at: number): Promise<bigint> {
  const f = path.join(dir, `probe-${at}.jpg`);
  await runFfmpeg(["-ss", String(at), "-i", path.join(dir, "out.mp4"), "-frames:v", "1", "-vf", LAYOUT, "-q:v", "4", f]);
  const h = await frameHash(f, dir);
  assert.ok(h !== null, `кадр на ${at}с разобран`);
  return h!;
}

test("1: изображение видно всю вставку, а вне её — A-roll", { timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-img-"));
  try {
    await fixture(dir);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", start: 1, end: 4, file: path.join(dir, "still.png") }],
    };
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});

    // эталоны: сама картинка и кадр исходного A-roll
    const refImg = path.join(dir, "ref-img.jpg");
    await runFfmpeg(["-i", path.join(dir, "still.png"), "-frames:v", "1", "-vf", LAYOUT, refImg]);
    const imgHash = (await frameHash(refImg, dir))!;

    // 1.1 / 2.5 / 3.9 — внутри вставки: должна быть картинка
    for (const at of [1.1, 2.5, 3.9]) {
      const d = hamming(imgHash, await outHash(dir, at));
      assert.ok(d <= 18, `на ${at}с должна быть картинка (расстояние ${d})`);
    }
    // 0.5 и 4.2 — вне вставки: картинки быть не должно
    for (const at of [0.5, 4.2]) {
      const d = hamming(imgHash, await outHash(dir, at));
      assert.ok(d > 18, `на ${at}с картинки быть не должно (расстояние ${d})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2: сверка даёт результат по КАЖДОЙ точке и ловит пропавшую вставку", { timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-conf-"));
  try {
    await fixture(dir);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", start: 1, end: 4, file: path.join(dir, "still.png") }],
    };

    // сначала честный рендер — все точки должны сойтись
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});
    const good = await checkRenderConformance(dir, path.join(dir, "out.mp4"), plan);
    assert.equal(good.points.length, good.expected, "результат есть по каждой запланированной точке");
    assert.equal(good.expected, checkPointsFor(plan.events[0]).length, "три точки на вставку");
    assert.equal(good.passed, good.expected, "все точки совпали");
    assert.ok(good.ok);

    // теперь ролик БЕЗ вставки: сверка обязана это увидеть
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=5:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "bare.mp4"),
    ]);
    const bad = await checkRenderConformance(dir, path.join(dir, "bare.mp4"), plan);
    assert.equal(bad.ok, false, "пропавшая вставка — жёсткий провал");
    assert.equal(bad.points.length, bad.expected, "и здесь результат по каждой точке");
    assert.equal(bad.failed, 3, "все три точки помечены как несовпавшие");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("3: недоступный материал даёт ошибку проверки, а не тишину", { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-err-"));
  try {
    await fixture(dir);
    await renderPlan(dir, path.join(dir, "aroll.mp4"), { version: 1, duration: 5, events: [], captionStyle: { ...DEFAULT_CAPTION_STYLE } }, 5, () => {});
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", start: 1, end: 4, file: path.join(dir, "нет-такого.jpg") }],
    };
    const r = await checkRenderConformance(dir, path.join(dir, "out.mp4"), plan);
    assert.equal(r.points.length, 3, "точки не пропущены");
    assert.equal(r.errored, 3, "каждая помечена ошибкой");
    assert.equal(r.ok, false, "непроверяемая вставка не считается успехом");
    assert.match(String(r.points[0].reason), /отсутствует на диске/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("4: решение по окну — отказ, если грязь рядом с началом", () => {
  const clean = { description: "medics around a stretcher", objects: [], environment: "", action: "", updatedAt: "" };
  const outro = { ...clean, description: "THANKS FOR WATCHING outro", hasChannelPromo: true, isTitleOrOutroCard: true, hasLargeText: true };

  // ровно случай из готового ролика: чисто только начало, дальше чужая карточка
  const rejected = segmentWindowDecision([clean, clean, outro, outro, outro] as any);
  assert.equal(rejected.decision, "REJECT", "0.8с чистого — меньше полутора, сегмент не берём");
  assert.equal(rejected.usableSec, 0.8);
  assert.equal(rejected.points.length, WINDOW_OFFSETS.length, "исход есть у каждой точки окна");
  assert.equal(rejected.points.filter((p) => p.verdict === null).length, 2);

  // грязь ближе к концу — окно подрезается, а не выбрасывается
  const trimmed = segmentWindowDecision([clean, clean, clean, clean, outro] as any);
  assert.equal(trimmed.decision, "TRIM");
  assert.equal(trimmed.usableSec, 2.4, "оставляем чистые 2.4с");

  // чистое окно проходит целиком
  const passed = segmentWindowDecision([clean, clean, clean, clean, clean] as any);
  assert.equal(passed.decision, "PASS");
  assert.equal(passed.usableSec, SEGMENT_WINDOW);

  // неописанный кадр — не повод считать окно чистым
  const unknown = segmentWindowDecision([null, clean, clean, clean, clean] as any);
  assert.equal(unknown.decision, "REJECT");
});

test("5: неравномерный визуал не пускает к оплате режиссёра", () => {
  const beats = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, visualNeed: "EXACT_EVENT" }));
  // ровно текущий случай: закрыта только середина, начало и конец пустые
  const middleOnly: any = {
    coverage: beats.map((b, i) => ({ beatId: b.id, bestScore: i >= 4 && i <= 7 ? 3 : 0 })),
    assets: [],
  };
  const d = packDistribution(middleOnly, beats, 60);
  assert.equal(d.firstExternalVisualAt, 20, "первый визуал только на двадцатой секунде");
  assert.equal(d.maxContinuousARoll, 20, "двадцать секунд подряд без материала в конце");
  assert.equal(d.externalCoverageFirstThird, 0);
  assert.equal(d.externalCoverageLastThird, 0);

  const pre = montagePreflight(middleOnly, beats, 60);
  assert.equal(pre.ok, false);
  assert.equal(pre.status, "NEEDS_MORE_MEDIA");
  assert.match(pre.reasons.join(" "), /первый визуал/);
  assert.match(pre.reasons.join(" "), /подряд/);

  // равномерно закрытый пакет проходит
  const even: any = { coverage: beats.map((b, i) => ({ beatId: b.id, bestScore: i % 2 === 0 ? 3 : 2 })), assets: [] };
  const ok = montagePreflight(even, beats, 60);
  assert.equal(ok.ok, true, ok.reasons.join("; "));
  assert.equal(ok.status, "READY");
});
