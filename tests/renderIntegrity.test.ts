import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runFfmpeg, probe } from "../lib/ffmpeg";
import { renderPlan } from "../lib/pipeline";
import { checkRenderConformance, checkPointsFor } from "../lib/renderConformance";
import { frameHash, hamming } from "../lib/sceneHash";
import { CARD, CARD_FILTER, CARD_CROP, AUTHOR_CROP, INTRO_ZOOM } from "../lib/topInset";
import { DEFAULT_CAPTION_STYLE, EditPlan } from "../lib/editPlan";
import { segmentWindowDecision, SEGMENT_WINDOW, WINDOW_OFFSETS } from "../lib/storyAssetPack";
import { packDistribution, montagePreflight } from "../lib/montageValidator";
import { blackBarReport } from "../lib/blackBars";
import { densifyTimeline, chainTimeline, MontageEvent } from "../lib/creativeDirector";

/**
 * Регрессия на НАСТОЯЩЕМ рендере, покадрово, без единого API-вызова.
 *
 * Верхняя карточка — всегда 900×506 на x=90, y=120; автор под ней виден; между
 * картинками нет пустого кадра; вступительный зум один. Каждое правило здесь
 * появилось после реального провала, который тесты на функциях не ловили.
 */

async function fixture(dir: string) {
  // A-roll со звуком и заметно другая горизонтальная картинка; обе со структурой:
  // перцептивный хэш сравнивает рисунок кадра, а не среднюю яркость
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

/** Хэш области карточки готового ролика в заданной секунде. */
async function cardHash(dir: string, at: number): Promise<bigint> {
  const f = path.join(dir, `card-${at}.jpg`);
  await runFfmpeg(["-ss", String(at), "-i", path.join(dir, "out.mp4"), "-frames:v", "1", "-vf", CARD_CROP, "-q:v", "4", f]);
  return (await frameHash(f, dir))!;
}

/** Эталон: картинка, приведённая к карточке тем же фильтром, что и в рендере. */
async function refHash(dir: string, src: string): Promise<bigint> {
  const f = path.join(dir, `ref-${path.basename(src)}.jpg`);
  await runFfmpeg(["-i", src, "-frames:v", "1", "-vf", CARD_FILTER, f]);
  return (await frameHash(f, dir))!;
}

test("1: карточка 900×506 сверху, автор снизу, вне вставки её нет, чёрных кадров нет", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-card-"));
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
    const ref = await refHash(dir, path.join(dir, "still.png"));

    assert.deepEqual({ ...CARD }, { w: 900, h: 506, x: 90, y: 120 }, "геометрия карточки фиксирована");

    for (const at of [1.2, 2.5, 3.8]) {
      assert.ok(hamming(ref, await cardHash(dir, at)) <= 18, `на ${at}с в карточке нет картинки`);
      const bottom = path.join(dir, `bot-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", AUTHOR_CROP, bottom]);
      assert.ok(hamming(ref, (await frameHash(bottom, dir))!) > 18, `на ${at}с картинка залезла в зону автора`);
    }
    for (const at of [0.5, 4.5]) {
      assert.ok(hamming(ref, await cardHash(dir, at)) > 18, `на ${at}с карточки быть не должно`);
    }
    for (const at of [0.9, 1.05, 3.95, 4.1]) {
      const f = path.join(dir, `blk-${at}.raw`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", f]);
      const px = fs.readFileSync(f);
      assert.ok(px.reduce((n, v) => n + v, 0) / px.length > 8, `чёрный кадр на ${at}с`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1b: горизонталь, квадрат и вертикаль дают ОДИНАКОВУЮ карточку 900×506", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-ar-"));
  try {
    for (const [name, size] of [["wide", "1600x900"], ["square", "1000x1000"], ["tall", "720x1280"]] as const) {
      const src = path.join(dir, `${name}.png`);
      await runFfmpeg(["-f", "lavfi", "-i", `testsrc2=s=${size}`, "-frames:v", "1", src]);
      const card = path.join(dir, `${name}-card.png`);
      await runFfmpeg(["-i", src, "-frames:v", "1", "-vf", CARD_FILTER, card]);
      const info = await probe(card);
      assert.equal(info.width, 900, `${name}: ширина ${info.width} — узкая полоса недопустима`);
      assert.equal(info.height, 506, `${name}: высота ${info.height}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1c: картинки сменяются встык, без пустого кадра между ними", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-seq-"));
  try {
    await fixture(dir);
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc=s=1600x900", "-frames:v", "1", path.join(dir, "second.png")]);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [
        { type: "B_ROLL", layout: "top_inset", start: 1, end: 2.5, file: path.join(dir, "still.png") },
        { type: "B_ROLL", layout: "top_inset", start: 2.5, end: 4.5, file: path.join(dir, "second.png") },
      ],
    };
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});
    const a = await refHash(dir, path.join(dir, "still.png"));
    const b = await refHash(dir, path.join(dir, "second.png"));
    assert.ok(hamming(a, await cardHash(dir, 2.4)) <= 18, "до смены — первая картинка");
    assert.ok(hamming(b, await cardHash(dir, 2.6)) <= 18, "после смены — вторая");
    const edge = await cardHash(dir, 2.5);
    assert.ok(hamming(a, edge) <= 18 || hamming(b, edge) <= 18, "на границе карточка пуста");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1d: единственный вступительный зум, дальше масштаб стабилен", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-zoom-"));
  try {
    await fixture(dir);
    await renderPlan(dir, path.join(dir, "aroll.mp4"), { version: 1, duration: 5, events: [], captionStyle: { ...DEFAULT_CAPTION_STYLE } }, 5, () => {});
    const out = path.join(dir, "out.mp4");
    // сравниваем угол кадра: при приближении он уходит за край, и вырезанный участок меняется
    const corner = async (at: number) => {
      const f = path.join(dir, `c-${at}.jpg`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "crop=200:200:0:0", f]);
      return (await frameHash(f, dir))!;
    };
    const h0 = await corner(0.05);
    const h1 = await corner(INTRO_ZOOM.seconds + 0.1);
    assert.ok(hamming(h0, h1) > 0, "к концу вступления кадр приблизился");
    assert.ok(INTRO_ZOOM.to >= 1.05 && INTRO_ZOOM.to <= 1.06, "масштаб 1.05–1.06");
    assert.ok(INTRO_ZOOM.seconds >= 1.2 && INTRO_ZOOM.seconds <= 1.8, "длительность 1.2–1.8с");
    const chain = fs.readFileSync("lib/pipeline.ts", "utf8");
    const render = chain.slice(chain.indexOf("export async function renderPlan"), chain.indexOf("async function selfCheck"));
    assert.equal((render.match(/introZoomFilter\(\)/g) ?? []).length, 1, "зум применён ровно один раз");
    assert.ok(!/PUNCH_IN|zoompan|\[0:v\]split/.test(render), "старой архитектуры punch-in и второй ветки нет");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("1e: видеофайл в карточке отвергается, внешний звук не участвует", { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-novid-"));
  try {
    await fixture(dir);
    await runFfmpeg([
      "-f", "lavfi", "-i", "smptebars=s=1600x900:d=2:r=30",
      "-f", "lavfi", "-i", "sine=frequency=1600:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "insert.mp4"),
    ]);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", layout: "top_inset", start: 1, end: 3, file: path.join(dir, "insert.mp4") }],
    };
    await assert.rejects(() => renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {}), /только изображения/);
    const chain = fs.readFileSync("lib/pipeline.ts", "utf8");
    const render = chain.slice(chain.indexOf("export async function renderPlan"));
    assert.ok(!/\[\d+:a\]/.test(render.slice(0, render.indexOf("audioChain"))), "внешний звук не подмешивается");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2: сверка даёт результат по КАЖДОЙ точке и ловит пропавшую картинку", { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-conf-"));
  try {
    await fixture(dir);
    const plan: EditPlan = {
      version: 1,
      duration: 5,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", layout: "top_inset", start: 1, end: 5, file: path.join(dir, "still.png") }],
    };
    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 5, () => {});
    const good = await checkRenderConformance(dir, path.join(dir, "out.mp4"), plan);
    assert.equal(good.points.length, good.expected, "результат есть по каждой точке");
    assert.equal(good.expected, checkPointsFor(plan.events[0]).length);
    assert.equal(good.passed, good.expected, good.points.map((p) => p.reason).join("; "));
    assert.deepEqual(good.gaps, [], "после первой картинки пустых секунд нет");
    assert.ok(good.ok);

    // ролик БЕЗ картинки: сверка обязана это увидеть
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=5:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "bare.mp4")]);
    const bad = await checkRenderConformance(dir, path.join(dir, "bare.mp4"), plan);
    assert.equal(bad.ok, false, "пропавшая картинка — жёсткий провал");
    assert.equal(bad.failed, 3, "все три точки помечены");
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
    assert.equal(r.ok, false);
    assert.match(String(r.points[0].reason), /отсутствует на диске/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("4: решение по окну — отказ, если грязь рядом с началом", () => {
  const clean = { description: "medics around a stretcher", objects: [], environment: "", action: "", updatedAt: "" };
  const outro = { ...clean, description: "THANKS FOR WATCHING outro", hasChannelPromo: true, isTitleOrOutroCard: true, hasLargeText: true };
  const rejected = segmentWindowDecision([clean, clean, outro, outro, outro] as any);
  assert.equal(rejected.decision, "REJECT");
  assert.equal(rejected.usableSec, 0.8);
  assert.equal(rejected.points.length, WINDOW_OFFSETS.length);
  const trimmed = segmentWindowDecision([clean, clean, clean, clean, outro] as any);
  assert.equal(trimmed.decision, "TRIM");
  assert.equal(trimmed.usableSec, 2.4);
  assert.equal(segmentWindowDecision([clean, clean, clean, clean, clean] as any).decision, "PASS");
  assert.equal(segmentWindowDecision([clean, clean, clean, clean, clean] as any).usableSec, SEGMENT_WINDOW);
  assert.equal(segmentWindowDecision([null, clean, clean, clean, clean] as any).decision, "REJECT");
});

test("5: неравномерный визуал не пускает к оплате режиссёра", () => {
  const beats = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, visualNeed: "EXACT_EVENT" }));
  const middleOnly: any = { coverage: beats.map((b, i) => ({ beatId: b.id, bestScore: i >= 4 && i <= 7 ? 3 : 0 })), assets: [] };
  const d = packDistribution(middleOnly, beats, 60);
  assert.equal(d.firstExternalVisualAt, 20);
  assert.equal(d.maxContinuousARoll, 20);
  const pre = montagePreflight(middleOnly, beats, 60);
  assert.equal(pre.status, "NEEDS_MORE_MEDIA");
  const even: any = { coverage: beats.map((b, i) => ({ beatId: b.id, bestScore: i % 2 === 0 ? 3 : 2 })), assets: [] };
  assert.equal(montagePreflight(even, beats, 60).status, "READY");
});

test("6: чёрные полосы внутри картинки распознаются, обычный кадр — нет", { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-bars-"));
  try {
    // вертикальная картинка в чёрной рамке 16:9 — ровно то, что выкладывают с телефона
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=506x900", "-frames:v", "1", "-vf", "pad=1600:900:(ow-iw)/2:0:black", path.join(dir, "pillar.png")]);
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=1600x900", "-frames:v", "1", path.join(dir, "plain.png")]);
    // и односторонняя полоса: картинка прижата к левому краю, чёрное только справа
    await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=s=1100x900", "-frames:v", "1", "-vf", "pad=1600:900:0:0:black", path.join(dir, "right-bar.png")]);
    const p = await blackBarReport(path.join(dir, "pillar.png"), dir);
    const q = await blackBarReport(path.join(dir, "plain.png"), dir);
    const r = await blackBarReport(path.join(dir, "right-bar.png"), dir);
    assert.equal(p.hasBars, true, `полосы не распознаны: ${JSON.stringify(p)}`);
    assert.equal(q.hasBars, false, `ложное срабатывание: ${JSON.stringify(q)}`);
    assert.equal(r.hasBars, true, `односторонняя полоса не распознана: ${JSON.stringify(r)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("7: долгое удержание делится неиспользованными картинками тех же блоков", () => {
  const beats: any[] = ["b0", "b1", "b2", "b3"].map((id) => ({ id, visualNeed: "ENTITY", text: id }));
  const asset = (id: string, scores: Record<string, number>, fam = "A") => ({
    id, kind: "IMAGE", file: id + ".jpg", sourceUrl: "", sourceDomain: "", description: id, role: "PERSON",
    compatibleBeatIds: Object.keys(scores), beatScores: scores, relatedFactIds: [], sceneFamily: fam,
    verification: { sourceVerified: true, visualVerified: true, version: 3 },
  });
  const pack: any = {
    assets: [asset("used", { b0: 3 }), asset("x1", { b1: 3 }, "B"), asset("x2", { b2: 2 }, "C"), asset("weak", { b1: 1 })],
    coverage: [],
  };
  const ev = (assetId: string, beatId: string, start: number, end: number): MontageEvent => ({
    type: "EXTERNAL_IMAGE", assetId, beatId, quote: "q", start, end, layout: "smart_crop", role: "PERSON",
  });
  // одна картинка держится 16 секунд, хотя под соседние блоки есть оценки 3 и 2
  const events = [ev("used", "b0", 3, 19), ev("tail", "b3", 19, 30)];
  densifyTimeline(events, pack, beats, 30);
  const ids = events.map((e) => e.assetId);
  assert.ok(ids.includes("x1") && ids.includes("x2"), `подходящие картинки вставлены: ${ids.join(",")}`);
  assert.ok(!ids.includes("weak"), "слабый контекст не берётся");
  assert.equal(new Set(ids).size, ids.length, "ни одна картинка не повторяется");
  chainTimeline(events, 30);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].start - events[i - 1].end <= 1 / 30 + 0.001, "дорожка осталась непрерывной");
  }
  assert.ok(events.every((e) => e.end - e.start <= 16), "удержание стало короче");

  // без подходящих кандидатов удержание не трогается
  const lone = [ev("used", "b0", 3, 19), ev("tail", "b3", 19, 30)];
  densifyTimeline(lone, { assets: [asset("used", { b0: 3 })], coverage: [] } as any, beats, 30);
  assert.equal(lone.length, 2, "нечем уплотнять — ничего не выдумано");
});
