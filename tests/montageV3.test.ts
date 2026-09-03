import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { locateQuote, chooseLayout, computeStats } from "../lib/creativeDirector";
import type { MontageEvent, MontagePlan } from "../lib/creativeDirector";
import { validateMontage } from "../lib/montageValidator";
import type { StoryAssetPackV2, PackAsset } from "../lib/storyAssetPack";
import type { Word } from "../lib/transcribe";

function asset(over: Partial<PackAsset> = {}): PackAsset {
  return {
    id: "a1",
    kind: "IMAGE",
    file: "img-a1.jpg",
    sourceUrl: "https://news/x",
    sourceDomain: "news",
    description: "что-то",
    role: "CONTEXT",
    compatibleBeatIds: ["b1"],
    relatedFactIds: [],
    verification: { sourceVerified: true, visualVerified: true, version: 2 },
    ...over,
  };
}
const pack = (assets: PackAsset[]): StoryAssetPackV2 => ({
  storyId: "s", version: 2, assets, coverage: [], coverageRatio: 1, hardCoverageRatio: 1, uniqueScenes: assets.length, sourceVideos: [], createdAt: "2026",
});
const ev = (over: Partial<MontageEvent> = {}): MontageEvent => ({
  type: "EXTERNAL_IMAGE", assetId: "a1", beatId: "b1", quote: "его увозят с поля",
  start: 5, end: 7.5, layout: "smart_crop", role: "CONTEXT", ...over,
});

test("1: порядок поиска задаёт сам блок сценария, а не квота на видео", () => {
  const src = fs.readFileSync("lib/storyAssetPack.ts", "utf8");
  const beat = src.slice(src.indexOf("BEAT: добор под блоки"), src.indexOf("сопоставление с блоками"));
  // фраза про человека или статичный факт не должна тянуть целый видеосюжет
  assert.ok(beat.includes('need.preferredMedia === "IMAGE"'), "учитывается предпочтение блока");
  assert.ok(beat.includes("await searchImages();"), "поиск картинок вынесен отдельно");
  assert.ok(beat.includes("await searchVideo();"), "поиск видео вынесен отдельно");
  const order = beat.slice(beat.indexOf("if (imageFirst) {"));
  const imgFirst = order.indexOf("await searchImages();");
  const vidFallback = order.indexOf("if (!gotImage) await searchVideo();");
  assert.ok(imgFirst >= 0 && vidFallback > imgFirst, "для IMAGE картинки идут первыми, видео — запасной вариант");
  // CORE-поиск главного видео истории сохранён
  assert.ok(src.includes("coreVideoQueries"), "CORE-поиск видео на месте");
});

test("2: одно исходное видео даёт несколько разных сегментов", () => {
  const src = fs.readFileSync("lib/storyAssetPack.ts", "utf8");
  const cut = src.slice(src.indexOf("async function cutSegments"), src.indexOf("function similar"));
  assert.ok(cut.includes("for (let i = 0; i < samples; i++)"));
  assert.ok(cut.includes("sourceVideoId: videoId"));
  assert.ok(cut.includes("seenDesc.some((d) => similar(d, an.description))"), "похожие кадры не дублируются");
});

test("3: режиссёр не может взять материал вне медиатеки", () => {
  const p: MontagePlan = { version: 3, duration: 30, events: [ev({ assetId: "ЧУЖОЙ" })], stats: computeStats([], 30, []) };
  const r = validateMontage(p, pack([asset()]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("отсутствует в медиатеке")));
  // и не может взять непроверенный
  const bad = asset({ verification: { sourceVerified: false, visualVerified: true, version: 2 } });
  const r2 = validateMontage({ ...p, events: [ev()] }, pack([bad]));
  assert.ok(r2.errors.some((e) => e.includes("не прошёл проверку")));
});

test("4: звук внешнего материала всегда выключен", () => {
  for (const f of ["lib/storyAssetPack.ts", "lib/videoFetch.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    if (f.endsWith("storyAssetPack.ts")) {
      // медиатека нового формата состоит только из стоп-кадров и фото:
      // у картинки звука нет по построению, отбрасывать нечего
      assert.ok(src.includes('kind: "IMAGE"'), `${f}: материалы — только картинки`);
      assert.ok(!src.includes('kind: "VIDEO_SEGMENT"'), `${f}: видео-сегменты в медиатеку больше не попадают`);
      continue;
    }
    if (src.includes("runFfmpeg")) assert.ok(src.includes('"-an"'), `${f}: аудио внешнего видео не отбрасывается`);
  }
  const taste = JSON.parse(fs.readFileSync("montage-taste.json", "utf8"));
  assert.equal(taste.external_audio, "off");
  assert.equal(taste.punch_in, "disabled");
  assert.equal(taste.text_callout, "disabled");
});

test("5: валидатор ловит повтор и требует дословную цитату", () => {
  const dup: MontagePlan = {
    version: 3, duration: 30,
    events: [ev(), ev({ start: 10, end: 12 })],
    stats: computeStats([], 30, []),
  };
  const r = validateMontage(dup, pack([asset()]));
  assert.ok(r.errors.some((e) => e.includes("использован дважды")));

  const noQuote: MontagePlan = { version: 3, duration: 30, events: [ev({ quote: "" })], stats: computeStats([], 30, []) };
  assert.ok(validateMontage(noQuote, pack([asset()])).errors.some((e) => e.includes("без дословной цитаты")));

  // цитата ищется в реальных словах, раскладка выбирается по пропорциям
  const words: Word[] = "его увозят с поля на носилках".split(" ").map((w, i) => ({ word: w, start: i, end: i + 0.8 }));
  assert.deepEqual(locateQuote(words, "увозят с поля"), { from: 1, to: 3 });
  assert.equal(locateQuote(words, "прыгает через щит"), null);
  assert.equal(chooseLayout(1080, 1920, "VIDEO_SEGMENT"), "fullscreen");
  assert.equal(chooseLayout(1920, 1080, "VIDEO_SEGMENT"), "fit_blurred");
});
