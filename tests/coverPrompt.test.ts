import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverImagePrompt, buildFullCoverPrompt } from "../lib/coverPrompt";
import type { CoverConcept } from "../lib/cover";

function concept(overrides: Partial<CoverConcept["composition"]> = {}): CoverConcept {
  return {
    headline: "ГЕНЫ\nНА ЗАКАЗ",
    headlineLines: [
      { text: "ГЕНЫ", accent: false },
      { text: "НА ЗАКАЗ", accent: "yellow" },
    ],
    emotion: "disturbed realization, eyes slightly wider than normal, subtle brow tension",
    scene: {
      mainSubject: "young man turning slightly toward the light",
      storyObject: "large DNA double helix medical visualization",
      environment: "modern genetics laboratory",
    },
    composition: { facePosition: "left", faceScale: "very_large", headlineArea: "lower", allowHands: false, ...overrides },
    design_notes: [],
  };
}

test("Prompt v4: фиксированный порядок секций IDENTITY→COMPOSITION→EXPRESSION→STORY→PHOTO→LIGHT→ANATOMY→NEG→TEXT→SAFE", () => {
  const p = buildCoverImagePrompt(concept());
  const order = [
    "@streamer = identity",
    "Vertical 9:16 chest-up",
    "Expression:",
    "Story:",
    "Photorealistic pro photo",
    "dramatic light",
    "Correct anatomy",
    "No painting",
    "no text, numbers",
    "Lower 35%",
  ];
  let last = -1;
  for (const marker of order) {
    const idx = p.indexOf(marker);
    assert.ok(idx > last, `секция «${marker}» не на месте (idx=${idx}, prev=${last})`);
    last = idx;
  }
});

test("Prompt v4: руки запрещены по умолчанию (allowHands=false)", () => {
  const p = buildCoverImagePrompt(concept({ allowHands: false }));
  assert.ok(p.includes("NO hands/fingers in frame"));
  assert.ok(p.includes("no invented gestures"));
});

test("Prompt v4: allowHands=true снимает запрет рук, но анатомия остаётся", () => {
  const p = buildCoverImagePrompt(concept({ allowHands: true }));
  assert.ok(!p.includes("NO hands/fingers"));
  assert.ok(p.includes("Correct anatomy"));
});

test("Prompt v4: режиссёрские переменные вставлены, лимит генератора соблюдён", () => {
  const p = buildCoverImagePrompt(concept());
  assert.ok(p.includes("DNA double helix"));
  assert.ok(p.includes("genetics laboratory"));
  assert.ok(p.includes("disturbed realization"));
  assert.ok(p.includes("slightly left"));
  assert.ok(p.includes("@streamer"));
  assert.ok(p.length <= 1000, `слишком длинный: ${p.length}`);
  assert.ok(p.length >= 700, `подозрительно короткий: ${p.length}`);
});

test("Prompt v4: запреты стиля и текста присутствуют всегда", () => {
  const p = buildCoverImagePrompt(concept());
  for (const banned of ["no neon", "plastic skin", "no text", "watermarks"]) {
    assert.ok(p.toLowerCase().includes(banned.toLowerCase()), `нет запрета: ${banned}`);
  }
});

test("Full-cover: секции в порядке IDENTITY→STORY→COMPOSITION→EXPRESSION→PHOTO→TYPOGRAPHY→EXACT TEXT→ANATOMY→NEG", () => {
  const c = concept();
  c.typographyDirection = "ACCENT_BOX";
  const p = buildFullCoverPrompt(c);
  const order = [
    "IDENTITY reference",
    "Story:",
    "Vertical 9:16 viral cover",
    "Expression:",
    "photorealistic editorial photograph",
    "integral part of this thumbnail composition",
    "exact Russian headline",
    "Correct human anatomy",
    "Strictly not",
  ];
  let last = -1;
  for (const marker of order) {
    const idx = p.indexOf(marker);
    assert.ok(idx > last, `«${marker}» не на месте (idx=${idx})`);
    last = idx;
  }
});

test("Full-cover: точный headline дословно, направление типографики вставлено, старых запретов текста нет", () => {
  const c = concept();
  c.typographyDirection = "ONE_WORD_DOMINANT";
  const p = buildFullCoverPrompt(c);
  assert.ok(p.includes('"ГЕНЫ\nНА ЗАКАЗ"'), "headline должен быть дословно");
  assert.ok(p.includes("gigantic and dominant"), "направление ONE_WORD_DOMINANT");
  assert.ok(p.includes("do not misspell Cyrillic"));
  assert.ok(!p.includes("Lower 35%"), "safe-area в full-режиме отсутствует");
  assert.ok(!p.includes("no text, numbers"), "запрет текста в full-режиме отсутствует");
});

test("Full-cover: руки запрещены по умолчанию, kicker попадает в EXACT TEXT", () => {
  const c = concept();
  c.kicker = "Генный шок";
  const p = buildFullCoverPrompt(c);
  assert.ok(p.includes("NO HANDS OR FINGERS"));
  assert.ok(p.includes('"ГЕННЫЙ ШОК"'));
});

test("Prompt v4: длинные значения от Claude обрезаются, лимит не пробивается", () => {
  const c = concept();
  c.emotion = "x".repeat(500);
  c.scene.storyObject = "y".repeat(500);
  c.scene.environment = "z".repeat(500);
  c.scene.mainSubject = "w".repeat(500);
  const p = buildCoverImagePrompt(c);
  assert.ok(p.length <= 1000, `лимит пробит: ${p.length}`);
});
