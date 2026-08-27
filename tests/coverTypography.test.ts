import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTypographyMode } from "../lib/coverTypography";
import type { HeadlineLine } from "../lib/coverLayout";

function lines(...texts: string[]): HeadlineLine[] {
  return texts.map((text) => ({ text, accent: false as const }));
}

test("Selector: короткие ударные headline уходят в FULL_AI", () => {
  for (const good of [
    lines("ДЕТИ", "НА ЗАКАЗ", "БОГАТЫМ"),
    lines("РАВЕНСТВО", "КОНЧИЛОСЬ"),
    lines("80 ЛЕТ", "СПУСТЯ"),
    lines("ПИЛОТ", "ВЫПРЫГНУЛ"),
    lines("ТИГР", "У ДОМА"),
    lines("ДЕНЬГИ", "СГОРЕЛИ"),
  ]) {
    const choice = selectTypographyMode(good);
    assert.equal(choice.mode, "FULL_AI", `${good.map((l) => l.text).join(" / ")}: ${choice.reasons.join("; ")}`);
    assert.equal(choice.reasons.length, 0);
  }
});

test("Selector: валюта и длинные числа уходят в RENDERER_TEXT", () => {
  const choice = selectTypographyMode(lines("5000$", "СТАЛИ", "300$"));
  assert.equal(choice.mode, "RENDERER_TEXT");
  assert.ok(choice.reasons.some((r) => r.includes("валюта")));
  assert.ok(choice.reasons.some((r) => r.includes("5000")));
  assert.ok(choice.reasons.some((r) => r.includes("больше одного числа")));
});

test("Selector: россыпь служебных слов — RENDERER_TEXT", () => {
  const choice = selectTypographyMode(lines("ТИГР", "ВО ДВОРЕ", "НЕ БЕГИ"));
  assert.equal(choice.mode, "RENDERER_TEXT");
  assert.ok(choice.reasons.some((r) => r.includes("служебных слов 2")));
});

test("Selector: спецсимволы, многословность и длина — RENDERER_TEXT", () => {
  assert.equal(selectTypographyMode(lines("5000$ → 300$")).mode, "RENDERER_TEXT");
  assert.equal(selectTypographyMode(lines("КАК Я", "ПОТЕРЯЛ", "ВСЕ СВОИ", "ДЕНЬГИ ТАМ")).mode, "RENDERER_TEXT");
  const long = selectTypographyMode(lines("НЕВЕРОЯТНОЕ", "ПРОИСШЕСТВИЕ", "СЛУЧИЛОСЬ"));
  assert.equal(long.mode, "RENDERER_TEXT");
  assert.ok(long.reasons.some((r) => r.includes("символов")));
});

test("Selector: одно короткое число (80 ЛЕТ) не выталкивает из FULL_AI", () => {
  assert.equal(selectTypographyMode(lines("80 ЛЕТ", "СПУСТЯ")).mode, "FULL_AI");
  assert.equal(selectTypographyMode(lines("300 ЛЕТ", "СПУСТЯ")).mode, "RENDERER_TEXT");
});
