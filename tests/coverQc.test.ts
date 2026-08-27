import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateQc, normalizeCoverText, buildRetryFeedback } from "../lib/coverQc";
import { buildCover, MAX_COVER_ATTEMPTS } from "../lib/coverPipeline";
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

// ===================== Пайплайн: только FULL_AI =====================

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

const TIGER = () => concept([{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }], KICKER);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gudini-cover-"));
}

/** Счётчики доказывают, что никакой альтернативный путь не вызывается. */
function stubDeps(qcResults: CoverQcResult[]) {
  const calls = { prompts: [] as string[], generated: [] as string[], qc: 0, finished: 0, encoded: 0 };
  return {
    calls,
    deps: {
      generateImage: async (prompt: string, out: string) => {
        calls.prompts.push(prompt);
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

test("1: первая попытка PASS → готово, лишних генераций нет", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([PASS]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, true);
  assert.equal(r.status, "PASS");
  assert.equal(r.attempts, 1);
  assert.deepEqual(calls.generated, ["cover-attempt-1.png"]);
  assert.equal(calls.encoded, 1);
  assert.ok(fs.existsSync(path.join(dir, "cover.jpg")));
  assert.ok(fs.existsSync(path.join(dir, "cover-final.png")));
});

test("2 и 3: провал QC ведёт к повторной генерации той же модели (до 3 попыток)", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, EXTRA, PASS]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.qcHistory, ["EXTRA_TEXT", "EXTRA_TEXT", "PASS"]);
  assert.deepEqual(calls.generated, ["cover-attempt-1.png", "cover-attempt-2.png", "cover-attempt-3.png"]);
  assert.equal(MAX_COVER_ATTEMPTS, 3);
});

test("4: три провала → COVER_FAILED и НИКАКОЙ обложки", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, EXTRA, EXTRA]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, "COVER_FAILED");
  assert.equal(r.attempts, 3);
  assert.equal(r.file, undefined);
  assert.equal(calls.generated.length, 3, "ровно 3 генерации, ни одной лишней");
  assert.equal(calls.encoded, 0);
  assert.equal(calls.finished, 0);
});

test("5–8: после провала не вызывается ни renderer, ни Runway, ни кадр из видео, ни другая модель", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, EXTRA, EXTRA]);
  // в CoverDeps физически нет renderText / runway / frame-cover — доказываем набором вызовов
  await buildCover(dir, TIGER(), deps);
  assert.deepEqual(
    calls.generated,
    ["cover-attempt-1.png", "cover-attempt-2.png", "cover-attempt-3.png"],
    "единственные обращения к генератору — попытки Full-AI",
  );
  assert.equal(calls.encoded, 0, "финальный файл не создаётся без PASS");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
  assert.equal(fs.existsSync(path.join(dir, "cover-clean-base.png")), false, "clean-base+renderer больше не существует");
  assert.equal(fs.existsSync(path.join(dir, "cover-text.ass")), false, "наш текстовый слой не применяется");
  const files = fs.readdirSync(dir);
  assert.equal(files.some((f) => f.includes("clean") || f.includes("runway") || f.includes("frame")), false);
});

test("9 и 10: headline и концепт не меняются между попытками", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, EXTRA, PASS]);
  await buildCover(dir, TIGER(), deps);
  for (const p of calls.prompts) {
    assert.ok(p.includes('"ТИГР\nУ ДОМА"'), "точный headline обязан быть в каждой попытке");
    assert.ok(p.includes("tiger in courtyard"), "story не меняется");
    assert.ok(p.includes("frozen alarm"), "эмоция не меняется");
  }
  // отличие между попытками — только корректирующая инструкция
  const base = calls.prompts[0];
  assert.ok(calls.prompts[1].startsWith(base), "вторая попытка = базовый промпт + feedback");
  assert.ok(calls.prompts[2].startsWith(base));
});

test("11: QC-feedback добавляется и называет конкретную причину", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, IDENTITY, PASS]);
  await buildCover(dir, TIGER(), deps);
  assert.ok(calls.prompts[1].includes("extra Russian-like text"), "причина №1 — лишний текст");
  assert.ok(calls.prompts[1].includes("ТОЛШИЙ ШИНСВ"), "feedback называет найденный мусор");
  assert.ok(calls.prompts[2].includes("preserve the reference identity"), "причина №2 — лицо");
  assert.ok(fs.existsSync(path.join(dir, "cover-prompt-2.txt")));
  assert.ok(fs.existsSync(path.join(dir, "cover-prompt-3.txt")));
});

test("12: финальная обложка появляется только после PASS", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([EXTRA, PASS]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, "cover.jpg")));
  const qc1 = JSON.parse(fs.readFileSync(path.join(dir, "cover-qc-1.json"), "utf8"));
  assert.equal(qc1.pass, false, "первая попытка сохранена как непрошедшая");
});

test("13–15: extra text, лицо и анатомия ведут к повторной генерации", async () => {
  for (const failure of [EXTRA, IDENTITY, ANATOMY]) {
    const dir = tmpDir();
    const { deps, calls } = stubDeps([failure, PASS]);
    const r = await buildCover(dir, TIGER(), deps);
    assert.equal(r.ok, true, `${failure.status} должен приводить к retry`);
    assert.equal(calls.generated.length, 2);
  }
});

test("Артефакты: сохраняются попытки, QC и cover-mode.json", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([EXTRA, PASS]);
  await buildCover(dir, TIGER(), deps);
  for (const f of ["cover-prompt.txt", "cover-attempt-1.png", "cover-qc-1.json", "cover-attempt-2.png", "cover-qc-2.json", "cover-final.png", "cover.jpg", "cover-mode.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `нет артефакта ${f}`);
  }
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.mode, "FULL_AI");
  assert.equal(mode.status, "PASS");
  assert.deepEqual(mode.qcHistory, ["EXTRA_TEXT", "PASS"]);
  assert.equal(mode.totalCost, 0.14); // 2 генерации + 2 QC
});

test("Сбой провайдера не роняет монтаж — status=ERROR без обложки", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([PASS]);
  deps.generateImage = async () => {
    throw new Error("IMAGE_PROVIDER_ERROR: 429");
  };
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, "ERROR");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
});

test("QC недоступен — это FAIL, а не пропуск проверки", async () => {
  const dir = tmpDir();
  const unavailable: CoverQcResult = { status: "QC_UNAVAILABLE", pass: false, reasons: ["нет ключа"], confidence: 0, cost: 0 };
  const { deps, calls } = stubDeps([unavailable, unavailable, unavailable]);
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.status, "COVER_FAILED");
  assert.equal(calls.encoded, 0, "без подтверждённого качества обложки не существует");
});

// ===================== 16: флаг =====================

test("16: FULL_AI_COVER=false — это выключение обложек, а не скрытый фолбэк", async () => {
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

test("Retry-подсказка фиксирует единственный разрешённый текст", () => {
  const fb = buildRetryFeedback(EXTRA, HEADLINE, null);
  assert.ok(fb.includes("extra Russian-like text"));
  assert.ok(fb.includes(`"${HEADLINE}"`));
  assert.ok(fb.includes("Do not generate any other letters"));
  assert.ok(fb.includes("Keep the same identity, concept, story and exact headline"));
});

test("Stats: считаются попытки и провалы, счётчиков фолбэка больше нет", () => {
  let s = readCoverStats(path.join(tmpDir(), "none.json"));
  s = applyCoverRun(s, { attempts: 1, status: "PASS", qc: "PASS", cost: 0.07 });
  s = applyCoverRun(s, { attempts: 2, status: "PASS", qc: "PASS", cost: 0.14 });
  s = applyCoverRun(s, { attempts: 3, status: "PASS", qc: "PASS", cost: 0.21 });
  s = applyCoverRun(s, { attempts: 3, status: "COVER_FAILED", qc: "EXTRA_TEXT", cost: 0.21 });
  assert.equal(s.totalCovers, 4);
  assert.equal(s.passFirst, 1);
  assert.equal(s.passSecond, 1);
  assert.equal(s.passThird, 1);
  assert.equal(s.failedAfterThree, 1);
  assert.equal(s.extraText, 1);
  assert.equal(s.totalCost, 0.63);
  assert.equal("fallback" in s, false);
});
