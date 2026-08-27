import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../lib/editPlan";
import { scoreRelevance, AssetAnalysis } from "../lib/brollRelevance";
import { Word } from "../lib/transcribe";
import type { VisualIntent } from "../lib/editPlan";

const words: Word[] = Array.from({ length: 120 }, (_, i) => ({
  word: `слово${i}`,
  start: i * 0.5,
  end: i * 0.5 + 0.42,
}));
const duration = 60;

test("1: production-план никогда не возвращает PUNCH_IN", () => {
  const events = validatePlan(
    [
      { type: "PUNCH_IN", from: 20, to: 30, scale: 1.06 },
      { type: "PUNCH_IN", from: 60, to: 70 },
    ] as any,
    words,
    duration,
  );
  assert.equal(events.length, 0, "приближение кадра меняло цвет A-roll и отключено");
});

test("2: production-план никогда не возвращает TEXT_CALLOUT", () => {
  const events = validatePlan(
    [
      { type: "TEXT_CALLOUT", from: 40, to: 44, text: "0 КАСАНИЙ МЯЧА" },
      { type: "GRAPHIC", from: 10, to: 14, graphic: ["1/8 ФИНАЛА"] },
    ] as any,
    words,
    duration,
  );
  assert.equal(events.length, 0, "крупная типографика остаётся только на обложке");
});

const boardIntent: VisualIntent = {
  subject: "football player near advertising board",
  action: "jumping over the board and falling",
  environment: "football pitch sideline",
  mood: "chaotic",
  mustHave: ["football", "advertising board"],
  avoid: ["skateboard", "skatepark", "parkour"],
};

test("3: без домена сюжета — отказ; с доменом, но неполный — годится как контекст", () => {
  // нет футбола вообще → отказ, каким бы «похожим» ни было действие
  const gymJump: AssetAnalysis = {
    description: "a man jumps over a box in a gym",
    objects: ["gym", "box", "athlete", "fitness"],
    environment: "gym",
    action: "jumping over an obstacle",
    updatedAt: "2026",
  };
  const bad = scoreRelevance(boardIntent, gymJump);
  assert.equal(bad.specificityFail, true);
  assert.ok(bad.reason.includes("football"), "не выполнено главное условие домена");

  // футбольный контекст без самого щита — честный контекстный кадр, а не подмена события
  const stadiumOnly: AssetAnalysis = {
    description: "football players on a pitch during a match",
    objects: ["stadium", "football", "pitch", "grass", "players"],
    environment: "football stadium",
    action: "playing football",
    updatedAt: "2026",
  };
  const ctx = scoreRelevance(boardIntent, stadiumOnly);
  assert.equal(ctx.specificityFail, false, "контекстный визуал лучше пустого A-roll");
  assert.ok(ctx.relevance > 0, "контекст получает ненулевую релевантность");
});

test("4: скейтер не заменяет футболиста у рекламного щита", () => {
  const skater: AssetAnalysis = {
    description: "a skateboarder jumps over an obstacle in a skatepark",
    objects: ["skateboard", "skater", "ramp", "obstacle", "concrete"],
    environment: "skatepark",
    action: "jumping over obstacle",
    updatedAt: "2026",
  };
  const r = scoreRelevance(boardIntent, skater);
  assert.equal(r.relevance, 0);
  assert.ok(r.avoidViolation || r.specificityFail, "похожее действие в другом контексте — не совпадение");
});

test("5: носилки без футбольного поля не подходят под «уносят с поля»", () => {
  const stretcherIntent: VisualIntent = {
    subject: "injured football player on a stretcher",
    action: "carried off the pitch",
    environment: "football stadium",
    mood: "tense",
    mustHave: ["football", "stretcher", "pitch"],
    avoid: ["street accident", "hospital corridor"],
  };
  const streetStretcher: AssetAnalysis = {
    description: "paramedics carry a person on a stretcher along a road",
    objects: ["stretcher", "paramedic", "ambulance", "road", "street"],
    environment: "city street",
    action: "carrying a stretcher",
    updatedAt: "2026",
  };
  const bad = scoreRelevance(stretcherIntent, streetStretcher);
  assert.equal(bad.relevance, 0, "просто носилки — это не «уносят с поля»");
  assert.ok(bad.avoidViolation || bad.specificityFail, "кандидат обязан быть отклонён");

  const onPitch: AssetAnalysis = {
    description: "medics carry an injured football player on a stretcher off the pitch",
    objects: ["football", "player", "stretcher", "medics", "pitch", "stadium"],
    environment: "football pitch in a stadium",
    action: "carrying injured player off the field",
    updatedAt: "2026",
  };
  const good = scoreRelevance(stretcherIntent, onPitch);
  assert.equal(good.specificityFail, false);
  assert.ok(good.relevance > 0.5);
});
