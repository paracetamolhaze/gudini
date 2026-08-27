import { test } from "node:test";
import assert from "node:assert/strict";
import { breakHeadline, computeLayout, measureText, buildCoverHeadlineAss } from "../lib/coverLayout";

test("Layout: самая широкая строка занимает 85–94% ширины кадра", () => {
  const lines = breakHeadline(
    [
      { text: "РАВЕНСТВО", accent: false },
      { text: "КОНЧИЛОСЬ", accent: true },
    ],
    "",
  );
  const layout = computeLayout(lines);
  assert.ok(layout.widthRatio >= 0.85 && layout.widthRatio <= 0.94, `widthRatio=${layout.widthRatio}`);
});

test("Layout: динамический размер — 2 короткие строки крупнее, чем 4", () => {
  const two = computeLayout(breakHeadline([{ text: "80 ЛЕТ", accent: false }, { text: "СПУСТЯ", accent: true }], ""));
  const four = computeLayout(
    breakHeadline(
      [
        { text: "ПРЫЖОК", accent: false },
        { text: "ЦЕНОЙ", accent: true },
        { text: "ЖИЗНИ", accent: false },
        { text: "СЕГОДНЯ", accent: false },
      ],
      "",
    ),
  );
  assert.ok(two.fontSize > four.fontSize, `${two.fontSize} vs ${four.fontSize}`);
  assert.ok(four.fontSize >= 110, "даже 4 строки остаются крупными");
});

test("Layout: блок занимает 25–40% высоты и не вылезает за safe-низ", () => {
  const layout = computeLayout(
    breakHeadline([{ text: "МУРАШКИ", accent: false }, { text: "ОТ ТРЕЙЛЕРА", accent: true }], ""),
  );
  assert.ok(layout.heightRatio <= 0.4 + 0.001, `height=${layout.heightRatio}`);
  const lastBottom = layout.lines[layout.lines.length - 1].y + layout.fontSize;
  assert.ok(lastBottom <= 1920 - 100, `низ блока ${lastBottom}`);
});

test("Layout: одна длинная строка автоматически бьётся на 2 сбалансированные", () => {
  const lines = breakHeadline(null, "РАВЕНСТВО КОНЧИЛОСЬ НАВСЕГДА");
  assert.equal(lines.length, 2);
  const w0 = measureText(lines[0].text, 100);
  const w1 = measureText(lines[1].text, 100);
  assert.ok(Math.abs(w0 - w1) / Math.max(w0, w1) < 0.6, "строки примерно сбалансированы");
});

test("Layout: без явного акцента жёлтой становится последняя строка", () => {
  const lines = breakHeadline(null, "ЕГО ИМЯ\nУЖЕ В НЕБЕ");
  assert.equal(lines[0].accent, false);
  assert.equal(lines[1].accent, true);
});

test("ASS: акцентная строка жёлтая, обычная белая, kicker присутствует", () => {
  const layout = computeLayout([
    { text: "ПРЫЖОК", accent: false },
    { text: "ЦЕНОЙ ЖИЗНИ", accent: true },
  ]);
  const ass = buildCoverHeadlineAss(layout, "РАЗБОР");
  const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(lines.length, 3); // kicker + 2 строки
  assert.ok(lines[0].includes("РАЗБОР"));
  assert.ok(!lines[1].includes("\\c&H00D7FF&"), "белая строка без жёлтого");
  assert.ok(lines[2].includes("\\c&H00D7FF&"), "акцентная строка жёлтая");
  assert.ok(ass.includes("Oswald"), "фирменный шрифт");
});

test("Layout: максимум 4 строки, мусорные символы вычищаются", () => {
  const lines = breakHeadline(
    [
      { text: "раз{}", accent: false },
      { text: "два\\", accent: false },
      { text: "три", accent: false },
      { text: "четыре", accent: false },
      { text: "пять", accent: false },
    ],
    "",
  );
  assert.equal(lines.length, 4);
  assert.equal(lines[0].text, "РАЗ");
});
