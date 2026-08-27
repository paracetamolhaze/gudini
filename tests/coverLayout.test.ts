import fs from "fs";
import path from "path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakHeadline,
  computeLayout,
  buildCoverHeadlineAss,
  checkGlyphCoverage,
  measureInk,
} from "../lib/coverLayout";

test("Layout v3: основные строки тянутся к ~93% ширины (ink-метрика)", () => {
  const layout = computeLayout(
    breakHeadline([{ text: "РАВЕНСТВО", accent: false }, { text: "КОНЧИЛОСЬ", accent: "yellow" }], ""),
  );
  assert.ok(layout.maxWidthRatio >= 0.85 && layout.maxWidthRatio <= 0.94, `ratio=${layout.maxWidthRatio}`);
  // обе основные строки широкие, не «узкий столбик»
  for (const l of layout.lines) {
    assert.ok(l.inkWidth / 1080 >= 0.8, `${l.text}: ${l.inkWidth}`);
  }
});

test("Layout v3: построчные размеры — короткая строка крупнее длинной", () => {
  const layout = computeLayout(
    breakHeadline([{ text: "ГЕНЫ", accent: false }, { text: "ЗАКАЗАНЫ", accent: "yellow" }], ""),
  );
  const [short, long] = layout.lines;
  assert.ok(short.fontSize > long.fontSize, `${short.fontSize} vs ${long.fontSize}`);
  // и при этом обе почти во всю ширину
  assert.ok(short.inkWidth / 1080 >= 0.8 && long.inkWidth / 1080 >= 0.8);
});

test("Layout v3: служебное слово («НА») — намеренно мелкое, а не во всю ширину", () => {
  const layout = computeLayout(
    breakHeadline(
      [
        { text: "ГЕНЫ", accent: false },
        { text: "НА", accent: false },
        { text: "ЗАКАЗ", accent: "yellow" },
      ],
      "",
    ),
  );
  const na = layout.lines[1];
  assert.ok(na.connector);
  assert.ok(na.fontSize < layout.lines[0].fontSize * 0.5, `НА=${na.fontSize} vs ${layout.lines[0].fontSize}`);
  // основные строки остаются огромными
  assert.ok(layout.lines[0].inkWidth / 1080 >= 0.8);
  assert.ok(layout.lines[2].inkWidth / 1080 >= 0.8);
});

test("Layout v3: блок ≤42% высоты, низ в safe-зоне, строки плотные", () => {
  const layout = computeLayout(
    breakHeadline(
      [
        { text: "ПРЫЖОК", accent: false },
        { text: "ЦЕНОЙ", accent: "box" },
        { text: "ЖИЗНИ", accent: false },
      ],
      "",
    ),
  );
  assert.ok(layout.heightRatio <= 0.42 + 0.001, `height=${layout.heightRatio}`);
  const last = layout.lines[layout.lines.length - 1];
  assert.ok(last.y + last.fontSize <= 1920 - 90, `низ=${last.y + last.fontSize}`);
  // межстрочный шаг = 0.84 размера строки (строки почти сцепляются)
  const gap = layout.lines[1].y - layout.lines[0].y;
  assert.ok(Math.abs(gap - layout.lines[0].fontSize * 0.84) <= 2, `gap=${gap}`);
});

test("ASS v3: box-акцент — жёлтая плашка с чёрным текстом, yellow — жёлтые буквы, scaleX применён", () => {
  const layout = computeLayout([
    { text: "ПРЫЖОК", accent: false },
    { text: "ЦЕНОЙ", accent: "box" },
    { text: "ЖИЗНИ", accent: "yellow" },
  ]);
  const ass = buildCoverHeadlineAss(layout);
  const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.ok(lines[1].includes("HeadBox") && lines[1].includes("\\1c&H000000&"), "box: чёрный текст");
  assert.ok(lines[1].includes("\\3c&H00D7FF&"), "box: жёлтая плашка");
  assert.ok(lines[2].includes("\\1c&H00D7FF&"), "yellow-строка");
  assert.ok(!lines[0].includes("\\1c&H00D7FF&"), "белая строка");
  assert.ok(ass.includes(`\\fscx${layout.scaleX}`), "горизонтальное сжатие только текстового слоя");
});

test("Glyph check: Montserrat Black покрывает АБВГД/абвгд/цифры/$%", () => {
  const buf = fs.readFileSync(path.join(process.cwd(), "fonts", "Montserrat-Black.ttf"));
  const res = checkGlyphCoverage(buf);
  assert.ok(res.ok, `missing: ${res.missing}`);
});

test("Glyph check: латинский шрифт без кириллицы отклоняется", () => {
  const buf = fs.readFileSync(path.join(process.cwd(), "fonts", "Anton-Regular.ttf"));
  const res = checkGlyphCoverage(buf);
  assert.equal(res.ok, false);
  assert.ok(res.missing.includes("А"));
});

test("breakHeadline: одна строка бьётся на 2, авто-акцент последней; максимум 4 строки", () => {
  const two = breakHeadline(null, "РАВЕНСТВО КОНЧИЛОСЬ НАВСЕГДА");
  assert.equal(two.length, 2);
  assert.equal(two[1].accent, "yellow");
  const many = breakHeadline(
    ["А", "Б", "В", "Г", "Д"].map((t) => ({ text: t, accent: false as const })),
    "",
  );
  assert.equal(many.length, 4);
});

test("measureInk: ink-ширина положительна и меньше advance для строки с пробелом на конце", () => {
  const ink = measureInk("ПРЫЖОК ", 100);
  assert.ok(ink.width > 0);
  assert.ok(ink.width < ink.advance, "хвостовой пробел не входит в ink");
});
