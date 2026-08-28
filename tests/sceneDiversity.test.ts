import { test } from "node:test";
import assert from "node:assert/strict";
import { groupScenes, hamming, SAME_SCENE_DISTANCE } from "../lib/sceneHash";
import { resetLedger, recordTokens } from "../lib/costLedger";
import { formatCostReport } from "../lib/costReport";

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
  recordTokens({ stage: "Script Beats", provider: "openrouter", model: "anthropic/claude-sonnet-4.5", inputTokens: 1000, outputTokens: 200, providerReportedCost: 0.01 });
  const report = formatCostReport("TEST");
  assert.match(report, /Script Beats\s+\$0\.0100/, "выполненная стадия показывает цену");
  assert.match(report, /Cover Generation\s+NOT RUN/, "невыполненная помечена NOT RUN");
  assert.match(report, /FULL VIDEO VARIABLE COST\s+недоступна/, "полная цена ролика не выдумывается");
  assert.match(report, /ASSET PACK COST/, "стоимость медиатеки отдельной строкой");
  assert.match(report, /CURRENT JOB COST/, "стоимость текущей задачи отдельной строкой");
});
