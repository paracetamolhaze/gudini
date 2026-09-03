import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runFfmpeg } from "../lib/ffmpeg";
import { renderPlan } from "../lib/pipeline";
import { checkRenderConformance, checkPointsFor } from "../lib/renderConformance";
import { frameHash, hamming } from "../lib/sceneHash";
import { insetBox, insetScaleFilter, insetCropFilter, INSET, AUTHOR_SAFE_TOP } from "../lib/topInset";
import { probe } from "../lib/ffmpeg";
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
  await runFfmpeg(["-f", "lavfi", "-i", "smptebars=s=1600x900", "-frames:v", "1", path.join(dir, "still.png")]);
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

test("1: вставка сверху, автор снизу виден, вне вставки её нет", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-inset-"));
  try {
    await fixture(dir);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", layout: "top_inset", start: 1, end: 4, file: path.join(dir, "still.png") }],
    };
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});
    const out = path.join(dir, "out.mp4");

    const box = insetBox(1600, 900); // горизонтальный исходник фикстуры
    assert.ok(box.w <= INSET.maxW && box.h <= INSET.maxH, "вставка не выходит за область");
    assert.equal(box.y, INSET.top, "верхняя координата фиксирована");
    assert.equal(box.x, Math.round((INSET.frameW - box.w) / 2), "по горизонтали по центру");

    // эталон вставки и эталон A-roll
    const refIns = path.join(dir, "ref-ins.jpg");
    await runFfmpeg(["-i", path.join(dir, "still.png"), "-frames:v", "1", "-vf", insetScaleFilter(box), refIns]);
    const insHash = (await frameHash(refIns, dir))!;

    const crop = insetCropFilter(box);
    const authorCrop = `crop=${INSET.frameW}:${INSET.frameH - AUTHOR_SAFE_TOP}:0:${AUTHOR_SAFE_TOP}`;

    // внутри вставки: сверху картинка, снизу автор
    for (const at of [1.2, 2.5, 3.8]) {
      const top = path.join(dir, `top-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", crop, top]);
      assert.ok(hamming(insHash, (await frameHash(top, dir))!) <= 18, `на ${at}с вставки нет сверху`);

      const bottom = path.join(dir, `bot-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", authorCrop, bottom]);
      const bh = (await frameHash(bottom, dir))!;
      assert.ok(hamming(insHash, bh) > 18, `на ${at}с вставка залезла в зону автора`);
    }

    // вне вставки её быть не должно
    for (const at of [0.5, 4.5]) {
      const top = path.join(dir, `off-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", crop, top]);
      assert.ok(hamming(insHash, (await frameHash(top, dir))!) > 18, `на ${at}с вставка не должна быть видна`);
    }

    // чёрных кадров быть не должно
    for (const at of [0.9, 1.05, 3.95, 4.1]) {
      const f = path.join(dir, `blk-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", f]);
      const px = fs.readFileSync(f);
      const mean = px.reduce((n, v) => n + v, 0) / px.length;
      assert.ok(mean > 8, `чёрный кадр на ${at}с (яркость ${mean.toFixed(1)})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1b: пропорции сохраняются для горизонтали, квадрата и вертикали", () => {
  const cases: [number, number][] = [[1600, 900], [1000, 1000], [720, 1280]];
  for (const [w, h] of cases) {
    const box = insetBox(w, h);
    assert.ok(box.w <= INSET.maxW && box.h <= INSET.maxH, `${w}x${h} вышел за область`);
    const srcAr = w / h;
    const boxAr = box.w / box.h;
    assert.ok(Math.abs(srcAr - boxAr) / srcAr < 0.02, `${w}x${h} растянут: ${srcAr.toFixed(2)} → ${boxAr.toFixed(2)}`);
    assert.equal(box.w % 2, 0);
    assert.equal(box.h % 2, 0);
  }
  // вертикальный упирается в высоту и становится уже — это нормально
  assert.equal(insetBox(720, 1280).h, INSET.maxH);
  assert.equal(insetBox(1600, 900).w, INSET.maxW);
});

test("1c: звук внешнего материала не попадает в результат", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-audio-"));
  try {
    await fixture(dir);
    // вставка со СВОИМ звуком на другой частоте
    await runFfmpeg([
      "-f", "lavfi", "-i", "smptebars=s=1600x900:d=3:r=30",
      "-f", "lavfi", "-i", "sine=frequency=1600:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      path.join(dir, "insert.mp4"),
    ]);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", layout: "top_inset", start: 1, end: 4, file: path.join(dir, "insert.mp4") }],
    };
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});
    const info = await probe(path.join(dir, "out.mp4"));
    assert.ok(info.hasAudio, "голос автора остался");
    // в готовом файле ровно одна аудиодорожка — авторская
    const chain = fs.readFileSync("lib/pipeline.ts", "utf8");
    const render = chain.slice(chain.indexOf("export async function renderPlan"));
    assert.ok(!/\[\d+:a\]/.test(render.slice(0, render.indexOf("audioChain"))), "дорожки вставок не подмешиваются");
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
