import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateQc, normalizeCoverText, detectImageMediaType } from "../lib/coverQc";
import { buildCover } from "../lib/coverPipeline";
import { applyCoverRun, readCoverStats } from "../lib/coverStats";
import { acceptKicker } from "../lib/cover";
import type { CoverConcept } from "../lib/cover";
import type { CoverQcResult } from "../lib/coverQc";

const HEADLINE = "ТИГР У ДОМА";
const KICKER = "ЧП В ГОРОДЕ";

function qc(overrides: Record<string, unknown> = {}) {
  return {
    readableText: ["ЧП В ГОРОДЕ", "ТИГР", "У ДОМА"],
    headlineMatch: true,
    extraText: [],
    textReadable: true,
    identityOk: true,
    anatomyOk: true,
    visualArtifacts: [],
    confidence: 0.96,
    ...overrides,
  };
}

// ===================== QC: вердикты =====================

test("QC: точный headline → PASS", () => {
  const r = evaluateQc(qc(), HEADLINE, KICKER);
  assert.equal(r.status, "PASS");
  assert.equal(r.pass, true);
});

test("QC: другой перенос строк → PASS (layout не учитываем)", () => {
  assert.equal(evaluateQc(qc({ readableText: ["ЧП В ГОРОДЕ", "ТИГР У ДОМА"] }), HEADLINE, KICKER).pass, true);
  assert.equal(normalizeCoverText("ТИГР\nУ  ДОМА!"), "ТИГР У ДОМА");
});

test("QC: перепутанные буквы (ТИРГ) → TEXT_MISMATCH", () => {
  const r = evaluateQc(qc({ readableText: ["ТИРГ", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "TEXT_MISMATCH");
  assert.equal(r.pass, false);
});

test("QC: придуманный текст (ТОЛШИЙ ШИНСВ) → EXTRA_TEXT", () => {
  const r = evaluateQc(qc({ readableText: ["ТОЛШИЙ ШИНСВ", "ТИГР", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "EXTRA_TEXT");
  assert.ok(r.extraText?.some((t) => t.includes("ТОЛШИЙ")));
});

test("QC: kicker отсутствует → PASS; kicker между строк заголовка → PASS", () => {
  assert.equal(evaluateQc(qc({ readableText: ["ТИГР", "У ДОМА"] }), HEADLINE, KICKER).pass, true);
  assert.equal(evaluateQc(qc({ readableText: ["ТИГР", "ЧП В ГОРОДЕ", "У ДОМА"] }), HEADLINE, KICKER).pass, true);
});

test("QC: неправильный kicker → FAIL; пропуск слова заголовка → FAIL", () => {
  assert.equal(evaluateQc(qc({ readableText: ["ЧП В ГОРОТЕ", "ТИГР", "У ДОМА"] }), HEADLINE, KICKER).status, "EXTRA_TEXT");
  assert.equal(evaluateQc(qc({ readableText: ["ТИГР", "ЧП В ГОРОДЕ", "ДОМА"] }), HEADLINE, KICKER).status, "TEXT_MISMATCH");
});

test("QC: нечитаемость, лицо, анатомия, артефакты", () => {
  assert.equal(evaluateQc(qc({ textReadable: false }), HEADLINE, KICKER).status, "UNREADABLE_TEXT");
  assert.equal(evaluateQc(qc({ identityOk: false }), HEADLINE, KICKER).status, "IDENTITY_PROBLEM");
  assert.equal(evaluateQc(qc({ anatomyOk: false }), HEADLINE, KICKER).status, "ANATOMY_PROBLEM");
  assert.equal(evaluateQc(qc({ visualArtifacts: ["шесть пальцев"] }), HEADLINE, KICKER).status, "VISUAL_ARTIFACTS");
});

test("QC: формат картинки определяется по байтам, а не по расширению (баг из E2E)", () => {
  // генератор кладёт JPEG в файл .png — заявленный по расширению media_type ломал запрос
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1")]);
  assert.equal(detectImageMediaType(jpeg), "image/jpeg");
  assert.equal(detectImageMediaType(png), "image/png");
  assert.equal(detectImageMediaType(Buffer.from("GIF89a....", "latin1")), "image/gif");
  assert.equal(detectImageMediaType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
});

// ===================== Пайплайн: ровно одна платная генерация =====================

function concept(lines: { text: string; accent: false | "yellow" | "box" }[], kicker?: string): CoverConcept {
  return {
    headline: lines.map((l) => l.text).join("\n"),
    headlineLines: lines,
    kicker,
    typographyDirection: "ACCENT_BOX",
    emotion: "frozen alarm",
    scene: { mainSubject: "person turning head", storyObject: "tiger in courtyard", environment: "courtyard" },
    composition: { facePosition: "left", faceScale: "very_large", headlineArea: "lower", allowHands: false },
    design_notes: [],
  };
}

const TIGER = () => concept([{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }]);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gudini-cover-"));
}

/** Мок генератора: считает КАЖДЫЙ платный вызов image-модели. */
function stubDeps(qcResults: CoverQcResult[]) {
  const calls = { generated: [] as string[], qc: 0, finished: 0, encoded: 0 };
  return {
    calls,
    deps: {
      generateImage: async (_prompt: string, out: string) => {
        calls.generated.push(path.basename(out));
        fs.writeFileSync(out, "png");
        return { cost: 0.068 };
      },
      runQc: async () => qcResults[calls.qc++] ?? qcResults[qcResults.length - 1],
      finish: async (_d: string, src: string, out: string) => {
        calls.finished++;
        fs.copyFileSync(src, out);
        return out;
      },
      encodeFinal: async (_d: string, _b: string, out: string) => {
        calls.encoded++;
        fs.writeFileSync(out, "jpg");
        return out;
      },
    },
  };
}

const PASS: CoverQcResult = { status: "PASS", pass: true, reasons: [], confidence: 0.95, cost: 0.002 };
const EXTRA: CoverQcResult = {
  status: "EXTRA_TEXT",
  pass: false,
  extraText: ["ТОЛШИЙ ШИНСВ"],
  reasons: ["мусорный текст"],
  confidence: 0.9,
  cost: 0.002,
};
const IDENTITY: CoverQcResult = { status: "IDENTITY_PROBLEM", pass: false, reasons: ["не похож"], confidence: 0.9, cost: 0.002 };
const ANATOMY: CoverQcResult = { status: "ANATOMY_PROBLEM", pass: false, reasons: ["анатомия"], confidence: 0.9, cost: 0.002 };

test("PASS: ровно одна генерация и готовая обложка", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([PASS]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, true);
  assert.equal(r.status, "PASS");
  assert.equal(calls.generated.length, 1);
  assert.equal(calls.encoded, 1);
  assert.ok(fs.existsSync(path.join(dir, "cover.jpg")));
  assert.equal(r.cost.total, 0.07);
});

test("ГЛАВНОЕ: при QC FAIL число генераций РОВНО 1 — авто-повтора нет", async () => {
  const dir = tmpDir();
  // мок вернул бы PASS на второй вызов — но второго вызова быть не должно
  const { deps, calls } = stubDeps([EXTRA, PASS, PASS]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(calls.generated.length, 1, "QC не имеет права инициировать новую генерацию");
  assert.equal(calls.qc, 1, "QC вызывается один раз — по одной картинке");
  assert.equal(r.status, "COVER_FAILED");
  assert.equal(r.ok, false);
  assert.equal(r.file, undefined);
  assert.equal(calls.encoded, 0, "финального файла без PASS не существует");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
  assert.equal(r.cost.total, 0.07, "оплачена ровно одна генерация");
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.generations, 1);
  assert.equal(mode.automaticRetries, 0);
});

test("Любая причина провала QC даёт одну генерацию и COVER_FAILED", async () => {
  for (const failure of [EXTRA, IDENTITY, ANATOMY]) {
    const dir = tmpDir();
    const { deps, calls } = stubDeps([failure, PASS]);
    const r = await buildCover(dir, TIGER(), deps);
    assert.equal(calls.generated.length, 1, `${failure.status}: без авто-повтора`);
    assert.equal(r.status, "COVER_FAILED");
  }
});

test("Ручная перегенерация — это ещё РОВНО одна генерация", async () => {
  const dir = tmpDir();
  // общий счётчик на оба запуска: имитируем нажатие «Перегенерировать» после провала
  const calls = { generated: 0 };
  const results = [EXTRA, PASS];
  let qcCall = 0;
  const deps = {
    generateImage: async (_p: string, out: string) => {
      calls.generated++;
      fs.writeFileSync(out, "png");
      return { cost: 0.068 };
    },
    runQc: async () => results[qcCall++],
    finish: async (_d: string, src: string, out: string) => (fs.copyFileSync(src, out), out),
    encodeFinal: async (_d: string, _b: string, out: string) => (fs.writeFileSync(out, "jpg"), out),
  };

  const first = await buildCover(dir, TIGER(), deps);
  assert.equal(first.status, "COVER_FAILED");
  assert.equal(calls.generated, 1, "после автоматического запуска — 1 генерация");

  const second = await buildCover(dir, TIGER(), deps, { manual: true });
  assert.equal(second.status, "PASS");
  assert.equal(calls.generated, 2, "нажатие пользователя добавило ровно одну генерацию");
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.manualRegeneration, true);
});

test("В пайплайне нет ни рендерера, ни Runway, ни кадра из видео", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([EXTRA]);
  await buildCover(dir, TIGER(), deps);
  const files = fs.readdirSync(dir);
  assert.equal(files.some((f) => /clean|runway|frame|cover-text\.ass|cover\.ass/.test(f)), false);
  assert.equal(fs.existsSync(path.join(dir, "cover-attempt-2.png")), false);
  assert.equal(fs.existsSync(path.join(dir, "cover-prompt-2.txt")), false, "второго промпта не существует");
});

test("Сбой провайдера: status=ERROR, обложки нет, повтора нет", async () => {
  const dir = tmpDir();
  let calls = 0;
  const r = await buildCover(dir, TIGER(), {
    generateImage: async () => {
      calls++;
      throw new Error("IMAGE_PROVIDER_ERROR: 429");
    },
  });
  assert.equal(r.status, "ERROR");
  assert.equal(calls, 1, "неудачный вызов не повторяется автоматически");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
});

test("QC недоступен — это FAIL, а не пропуск проверки", async () => {
  const dir = tmpDir();
  const unavailable: CoverQcResult = { status: "QC_UNAVAILABLE", pass: false, reasons: ["нет ключа"], confidence: 0, cost: 0 };
  const { deps, calls } = stubDeps([unavailable]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.status, "COVER_FAILED");
  assert.equal(calls.generated.length, 1);
  assert.equal(calls.encoded, 0);
});

test("Артефакты одной попытки", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([PASS]);
  await buildCover(dir, TIGER(), deps);
  for (const f of ["cover-prompt.txt", "cover-attempt-1.png", "cover-qc-1.json", "cover-final.png", "cover.jpg", "cover-mode.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `нет артефакта ${f}`);
  }
});

test("FULL_AI_COVER=false — выключение обложек, а не скрытый фолбэк", async () => {
  const { fullAiCoverEnabled, fullAiCoverModel, DEFAULT_FULL_AI_MODEL } = await import("../lib/coverProvider");
  const prev = process.env.FULL_AI_COVER;
  try {
    delete process.env.FULL_AI_COVER;
    assert.equal(fullAiCoverEnabled(), true);
    process.env.FULL_AI_COVER = "false";
    assert.equal(fullAiCoverEnabled(), false);
    assert.equal(DEFAULT_FULL_AI_MODEL, "google/gemini-3.1-flash-image", "Pro автоматически не используется");
    assert.equal(fullAiCoverModel(), DEFAULT_FULL_AI_MODEL);
  } finally {
    if (prev === undefined) delete process.env.FULL_AI_COVER;
    else process.env.FULL_AI_COVER = prev;
  }
});

// ===================== Планировщик и статистика =====================

test("Kicker необязателен: по умолчанию его нет, длинный отбрасывается", () => {
  assert.equal(acceptKicker(null), undefined);
  assert.equal(acceptKicker(""), undefined);
  assert.equal(acceptKicker("нет"), undefined);
  assert.equal(acceptKicker("ЧП В ГОРОДЕ"), undefined, "3 слова — слишком рискованно");
  assert.equal(acceptKicker("ГЕННЫЙ ШОК"), "ГЕННЫЙ ШОК");
  assert.equal(acceptKicker("ИТОГИ"), "ИТОГИ");
});

test("Stats: generated / passedQc / failedQc / manualRegenerations", () => {
  let s = readCoverStats(path.join(tmpDir(), "none.json"));
  s = applyCoverRun(s, { status: "PASS", qc: "PASS", cost: 0.07 });
  s = applyCoverRun(s, { status: "COVER_FAILED", qc: "EXTRA_TEXT", cost: 0.07 });
  s = applyCoverRun(s, { status: "PASS", qc: "PASS", cost: 0.07, manual: true });
  assert.equal(s.generated, 3);
  assert.equal(s.passedQc, 2);
  assert.equal(s.failedQc, 1);
  assert.equal(s.manualRegenerations, 1);
  assert.equal(s.extraText, 1);
  assert.equal(s.totalCost, 0.21);
  for (const gone of ["passSecond", "passThird", "failedAfterThree", "fallback"]) {
    assert.equal(gone in s, false, `счётчик ${gone} должен быть удалён`);
  }
});
