import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

/**
 * Архитектурные проверки медиатеки v2. Сетевых вызовов здесь нет — проверяется
 * порядок этапов и правила, а не результаты поиска.
 */

const packSrc = fs.readFileSync("lib/storyAssetPack.ts", "utf8");
const beatsSrc = fs.readFileSync("lib/scriptBeats.ts", "utf8");

test("1: медиатека строится ПОСЛЕ сценария и знает его блоки", () => {
  assert.ok(
    /export async function buildAssetPack\(\s*research: StoryResearchPack,\s*beats: ScriptBeat\[\],\s*needs: MediaResearchNeed\[\]/.test(
      packSrc,
    ),
    "buildAssetPack принимает и историю, и блоки сценария",
  );
  // блоки сценария появляются раньше — у них своя стадия
  assert.ok(beatsSrc.includes("export async function buildScriptBeats"), "есть отдельная стадия разбора сценария");
  assert.ok(beatsSrc.includes("MediaResearchNeed"), "план медиа-исследования формируется из блоков");
});

test("2: запрос под блок содержит и контекст истории, и контекст блока", () => {
  const fn = packSrc.slice(packSrc.indexOf("function beatQueries"), packSrc.indexOf("async function cutSegments"));
  assert.ok(fn.includes("need.visualDescription"), "используется описание нужного кадра");
  assert.ok(fn.includes("r.eventYear"), "используется год события");
  assert.ok(fn.includes("need.entities") && fn.includes("r.entities"), "используются участники истории");
  // главное видео ищется отдельным набором запросов по всей истории
  const core = packSrc.slice(packSrc.indexOf("function coreVideoQueries"), packSrc.indexOf("function beatQueries"));
  assert.ok(core.includes("r.canonicalEvent"), "CORE ищет по каноническому событию");
});

test("3: незакрытые блоки добираются точечно, пороги качества не снижаются", () => {
  // добор идёт по важности блоков, а не через ослабление проверок
  assert.ok(/rank\(a\.importance\)|need\.importance === "HIGH"/.test(packSrc), "важные блоки получают больший бюджет");
  assert.ok(!/relax|смягч|lower.*threshold/i.test(packSrc), "нет логики ослабления требований");
  // проверки применяются к каждому кандидату одинаково
  assert.ok(packSrc.includes("verifySource("), "источниковая проверка обязательна");
  assert.ok(packSrc.includes("an.isScreenshot || an.hasLargeText || an.hasLargeWatermark"), "скриншоты отсекаются");
});

test("4: одно исходное видео даёт НЕСКОЛЬКО разных сегментов", () => {
  const cut = packSrc.slice(packSrc.indexOf("async function cutSegments"), packSrc.indexOf("function similar"));
  assert.ok(cut.includes("for (let i = 0; i < samples; i++)"), "видео сэмплируется по таймлайну");
  assert.ok(cut.includes("sourceVideoId: videoId"), "сегменты помнят исходное видео");
  assert.ok(cut.includes("seenDesc.some((d) => similar(d, an.description))"), "почти одинаковые кадры не дублируются");
  assert.ok(cut.includes('"-an"'), "звук исходного видео не сохраняется");
});

test("5: в пакет попадают только материалы, совместимые с блоками", () => {
  assert.ok(
    packSrc.includes("const usable = matched.filter((a) => a.compatibleBeatIds.length);"),
    "материал без единого совместимого блока в пакет не попадает",
  );
  assert.ok(packSrc.includes("assets: usable"), "в пакет уходят только пригодные");
  // роли честные: EVENT не присваивается по усмотрению
  assert.ok(packSrc.includes("Не присваивай EVENT, если на кадре не происходит именно описанное"), "роль EVENT ограничена");
});
