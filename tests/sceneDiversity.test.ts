import { test } from "node:test";
import assert from "node:assert/strict";
import { groupScenes, hamming, SAME_SCENE_DISTANCE } from "../lib/sceneHash";
import { resetLedger, recordTokens, projectRequestCost } from "../lib/costLedger";
import { formatCostReport } from "../lib/costReport";
import { packFingerprint } from "../lib/storyAssetPack";
import { beatsFingerprint } from "../lib/scriptBeats";

test("1: почти одинаковые планы — одна сцена, разные моменты — разные", () => {
  const base = 0b1010101010101010101010101010101010101010101010101010101010101010n;
  // тот же план: отличается парой битов (шум сжатия)
  const nearly = base ^ 0b111n;
  // другой момент съёмки: половина битов другая
  const other = base ^ 0xffffffffn;

  assert.ok(hamming(base, nearly) <= SAME_SCENE_DISTANCE, "шум не делает новую сцену");
  assert.ok(hamming(base, other) > SAME_SCENE_DISTANCE, "смена плана делает новую сцену");

  const groups = groupScenes([base, nearly, other, base ^ 0b11n]);
  assert.equal(groups[0], groups[1], "почти одинаковые кадры в одной сцене");
  assert.equal(groups[0], groups[3], "и третий похожий тоже");
  assert.notEqual(groups[0], groups[2], "непохожий кадр — отдельная сцена");
  assert.equal(new Set(groups).size, 2, "четыре кадра дают две сцены, а не четыре");

  // кадр без хэша не сливается со всеми подряд
  const withNull = groupScenes([base, null, null]);
  assert.equal(new Set(withNull).size, 3, "неизвестный кадр считается отдельным");
});

test("2: невыполненная стадия помечается NOT RUN, а не нулём", () => {
  resetLedger();
  recordTokens({ stage: "Script Beats", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 200, providerReportedCost: 0.01 });
  const report = formatCostReport("TEST");
  assert.match(report, /Script Beats\s+\$0\.0100/, "выполненная стадия показывает цену");
  assert.match(report, /Cover Generation\s+NOT RUN/, "невыполненная помечена NOT RUN");
  assert.match(report, /CURRENT RUN COST/, "стоимость прогона отдельной строкой");
  assert.match(report, /FULL VIDEO VARIABLE COST: INCOMPLETE/, "полная цена ролика не выдумывается");
  assert.match(report, /KNOWN COST SO FAR: \$/, "показано, что известно на сегодня");
  assert.match(report, /NOT RUN \(нулём не считаем\)/, "невыполненные стадии перечислены");
  assert.match(report, /ASSET PACK\s+\$/, "стоимость медиатеки отдельной строкой");
  assert.match(report, /CURRENT RUN COST/, "стоимость текущего прогона отдельной строкой");
  assert.match(report, /PROVIDER TOTALS \/ ONE VIDEO/, "итоги по провайдерам на один ролик");
});

test("3: медиатека пересобирается только при изменении входных данных", () => {
  const research: any = {
    storyId: "s1",
    canonicalEvent: "событие",
    facts: [{ id: "f1" }, { id: "f2" }],
    entities: [{ name: "A" }, { name: "B" }],
  };
  const beats: any[] = [
    { id: "b1", visualNeed: "EXACT_EVENT" },
    { id: "b2", visualNeed: "CONTEXT" },
  ];
  const base = packFingerprint(research, beats);

  // повторный рендер того же ролика не меняет отпечаток — платить снова не за что
  assert.equal(packFingerprint(research, beats), base, "те же данные — тот же отпечаток");
  // порядок фактов и участников роли не играет
  const shuffled = { ...research, facts: [{ id: "f2" }, { id: "f1" }], entities: [{ name: "B" }, { name: "A" }] };
  assert.equal(packFingerprint(shuffled as any, beats), base, "перестановка не делает пакет невалидным");

  // а вот изменение истории или блоков — делает
  assert.notEqual(packFingerprint({ ...research, canonicalEvent: "другое" } as any, beats), base, "другая история");
  assert.notEqual(packFingerprint({ ...research, facts: [{ id: "f1" }] } as any, beats), base, "другие факты");
  assert.notEqual(
    packFingerprint(research, [{ id: "b1", visualNeed: "CONTEXT" }, beats[1]] as any),
    base,
    "изменилась потребность блока в визуале",
  );
});

test("4: оценка стоимости резервируется ДО запроса", () => {
  // запрос со зрением дороже текстового: кадры считаются отдельно
  const text = projectRequestCost({ model: "claude-sonnet-5", promptChars: 6000, maxTokens: 2000 });
  const vision = projectRequestCost({ model: "claude-sonnet-5", promptChars: 6000, images: 6, maxTokens: 2000 });
  assert.ok(vision > text, "кадры увеличивают оценку");
  assert.ok(text > 0, "оценка не нулевая");

  // выход считается по max_tokens — намеренно пессимистично
  const small = projectRequestCost({ model: "claude-sonnet-5", promptChars: 6000, maxTokens: 500 });
  assert.ok(small < text, "меньший потолок ответа — меньшая оценка");

  // неизвестный тариф не должен превращаться в ноль
  assert.ok(projectRequestCost({ model: "неизвестная-модель", promptChars: 100, maxTokens: 100 }) > 0.1);
});

test("5: блоки сценария переиспользуются при неизменных входных данных", () => {
  const research: any = {
    storyId: "s1",
    canonicalEvent: "событие",
    facts: [{ id: "f1" }],
    entities: [{ name: "A" }],
  };
  const a = beatsFingerprint("текст сценария", research);
  assert.equal(beatsFingerprint("текст сценария", research), a, "тот же сценарий — тот же отпечаток");
  assert.notEqual(beatsFingerprint("другой текст", research), a, "правка сценария требует нового разбора");
  assert.notEqual(
    beatsFingerprint("текст сценария", { ...research, facts: [{ id: "f2" }] } as any),
    a,
    "смена фактов требует нового разбора",
  );
});
