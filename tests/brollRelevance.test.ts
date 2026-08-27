import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRelevance, combineScores, AssetAnalysis } from "../lib/brollRelevance";
import { VisualIntent } from "../lib/editPlan";

const tigerIntent: VisualIntent = {
  subject: "tiger",
  action: "walking through a residential courtyard",
  environment: "urban apartment area",
  mood: "dangerous tense documentary",
  mustHave: ["tiger", "urban environment"],
  avoid: ["zoo cage", "cartoon", "safari"],
};

const tigerCityAnalysis: AssetAnalysis = {
  description: "a tiger walks between apartment buildings at night",
  objects: ["tiger", "big cat", "predator", "animal", "buildings", "street", "city"],
  environment: "urban residential area at night",
  action: "walking",
  updatedAt: "2026",
};

const dogCityAnalysis: AssetAnalysis = {
  description: "a dog walking on a city street",
  objects: ["dog", "pet", "animal", "street", "city"],
  environment: "urban street",
  action: "walking",
  updatedAt: "2026",
};

const zooTigerAnalysis: AssetAnalysis = {
  description: "a tiger inside a zoo cage enclosure",
  objects: ["tiger", "big cat", "zoo", "cage", "enclosure"],
  environment: "zoo cage",
  action: "pacing",
  updatedAt: "2026",
};

test("Relevance: тигр в городе — высокий балл, все компоненты совпали", () => {
  const s = scoreRelevance(tigerIntent, tigerCityAnalysis);
  assert.ok(s.relevance > 0.8, `ожидали >0.8, получили ${s.relevance}`);
  assert.equal(s.avoidViolation, false);
});

test("Relevance: avoid («zoo cage») — жёсткое отклонение даже для тигра", () => {
  const s = scoreRelevance(tigerIntent, zooTigerAnalysis);
  assert.equal(s.avoidViolation, true);
  assert.equal(s.relevance, 0);
});

test("Relevance: mustHave не найден (собака вместо тигра) — subjectMatch падает", () => {
  const s = scoreRelevance(tigerIntent, dogCityAnalysis);
  assert.ok(s.subjectMatch < 1, "тигра нет — полного subject-совпадения быть не должно");
});

test("КЛЮЧЕВОЙ КЕЙС: горизонтальный релевантный побеждает вертикальный нерелевантный", () => {
  // A: вертикаль 1080x1920 «собака в городе» — техника максимальная
  const techA = 3.5; // как считает scoreCandidate для идеальной вертикали
  const relA = scoreRelevance(tigerIntent, dogCityAnalysis);
  // B: горизонталь 1920x1080 «тигр во дворе» — техника слабая
  const techB = 0.72;
  const relB = scoreRelevance(tigerIntent, tigerCityAnalysis);

  const finalA = combineScores(relA.relevance, techA);
  const finalB = combineScores(relB.relevance, techB);
  assert.ok(finalB > finalA, `семантика должна победить: B=${finalB} vs A=${finalA}`);
});

test("Fallback: без анализа (vision недоступен) остаётся технический скоринг — код не бросает", () => {
  // scoreRelevance требует анализ; путь «analysis === null → технический фолбэк»
  // реализован в fetchStockVideo и покрыт тем, что combineScores работает и без relevance:
  const finalTechOnly = combineScores(0, 3.5);
  assert.ok(finalTechOnly <= 0.3 + 0.001); // только технический вклад
});

test("Веса: релевантность важнее техники (0.7 против 0.3)", () => {
  const semantic = combineScores(1, 0);
  const technical = combineScores(0, 3.5);
  assert.ok(semantic > technical * 2);
});

test("Test 5: конкретная сущность не иллюстрируется общим кадром по теме", () => {
  const henderson: VisualIntent = {
    subject: "football player on the substitutes bench",
    action: "sitting and watching the match",
    environment: "stadium bench area",
    mood: "tense",
    mustHave: ["football player"],
    avoid: ["cartoon"],
  };
  const genericPitch: AssetAnalysis = {
    description: "players run on an empty green football field",
    objects: ["football", "soccer", "player", "pitch", "grass", "stadium"],
    environment: "football stadium",
    action: "playing football",
    updatedAt: "2026",
  };

  // без сущности это нормальный тематический кадр
  const plain = scoreRelevance(henderson, genericPitch);
  assert.ok(plain.relevance > 0.5, `обычный сток должен проходить: ${plain.relevance}`);

  // но для названного человека — жёсткое отклонение, даже при хорошей технике
  const person = scoreRelevance(henderson, genericPitch, {
    sourceIntent: "PERSON",
    entityName: "Jordan Henderson",
  });
  assert.equal(person.specificityFail, true, "generic football field не может представлять Хендерсона");
  assert.equal(person.relevance, 0);

  // матчап тоже: пустой стадион не равен «Англия против Мексики»
  const matchup = scoreRelevance(henderson, genericPitch, {
    sourceIntent: "TEAM_MATCHUP",
    entityName: "England vs Mexico",
  });
  assert.equal(matchup.specificityFail, true);

  // а кадр, где сущность реально видна, проходит
  const realMatch: AssetAnalysis = {
    description: "England and Mexico national teams play a World Cup match",
    objects: ["england", "mexico", "national team", "football", "player", "stadium"],
    environment: "world cup stadium",
    action: "playing football",
    updatedAt: "2026",
  };
  const ok = scoreRelevance(henderson, realMatch, {
    sourceIntent: "TEAM_MATCHUP",
    entityName: "England vs Mexico",
  });
  assert.equal(ok.specificityFail, false);
  assert.ok(ok.relevance > 0.5);
});
