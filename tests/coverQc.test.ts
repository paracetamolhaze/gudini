import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateQc, normalizeCoverText, buildRetryFeedback } from "../lib/coverQc";
import { buildCover } from "../lib/coverPipeline";
import { applyCoverRun, readCoverStats } from "../lib/coverStats";
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
    obviousIdentityFailure: false,
    obviousAnatomyFailure: false,
    confidence: 0.96,
    ...overrides,
  };
}

// --- 1..6: логика QC ---

test("QC 1: точный headline → PASS", () => {
  const r = evaluateQc(qc(), HEADLINE, KICKER);
  assert.equal(r.status, "PASS");
  assert.equal(r.reasons.length, 0);
});

test("QC 2: другой перенос строк → PASS (layout не учитываем)", () => {
  const r = evaluateQc(qc({ readableText: ["ЧП В ГОРОДЕ", "ТИГР У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "PASS");
  assert.equal(normalizeCoverText("ТИГР\nУ  ДОМА!"), "ТИГР У ДОМА");
});

test("QC 3: перепутанные буквы (ТИРГ) → FAIL", () => {
  const r = evaluateQc(qc({ readableText: ["ЧП В ГОРОДЕ", "ТИРГ", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "TEXT_MISMATCH");
  assert.ok(r.reasons[0].includes("не совпал"));
});

test("QC 4: придуманный моделью текст (ТОЛШИЙ ШИНСВ) → EXTRA_TEXT", () => {
  const r = evaluateQc(
    qc({ readableText: ["ЧП В ГОРОДЕ", "ТОЛШИЙ ШИНСВ", "ТИГР", "У ДОМА"] }),
    HEADLINE,
    KICKER,
  );
  assert.equal(r.status, "EXTRA_TEXT");
  assert.ok(r.reasons[0].includes("ТОЛШИЙ"));
});

test("QC 5: kicker отсутствует, headline идеальный → PASS", () => {
  const r = evaluateQc(qc({ readableText: ["ТИГР", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "PASS");
});

test("QC: kicker МЕЖДУ строками заголовка — валидная вёрстка → PASS (случай из E2E)", () => {
  const r = evaluateQc(qc({ readableText: ["ТИГР", "ЧП В ГОРОДЕ", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "PASS", r.reasons.join("; "));
});

test("QC: пропуск слова внутри заголовка ловится даже при вклиненном kicker", () => {
  const r = evaluateQc(qc({ readableText: ["ТИГР", "ЧП В ГОРОДЕ", "ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "TEXT_MISMATCH");
});

test("QC 6: неправильный kicker → FAIL", () => {
  const r = evaluateQc(qc({ readableText: ["ЧП В ГОРОТЕ", "ТИГР", "У ДОМА"] }), HEADLINE, KICKER);
  assert.equal(r.status, "EXTRA_TEXT");
});

test("QC: нечитаемый текст и провалы личности/анатомии", () => {
  assert.equal(evaluateQc(qc({ textReadable: false }), HEADLINE, KICKER).status, "UNREADABLE_TEXT");
  assert.equal(evaluateQc(qc({ obviousIdentityFailure: true }), HEADLINE, KICKER).status, "IDENTITY_PROBLEM");
  assert.equal(evaluateQc(qc({ obviousAnatomyFailure: true }), HEADLINE, KICKER).status, "ANATOMY_PROBLEM");
});

// --- 7..10: поведение пайплайна ---

function concept(lines: { text: string; accent: false | "yellow" | "box" }[]): CoverConcept {
  return {
    headline: lines.map((l) => l.text).join("\n"),
    headlineLines: lines,
    kicker: KICKER,
    typographyDirection: "ACCENT_BOX",
    emotion: "frozen alarm",
    scene: { mainSubject: "person turning head", storyObject: "tiger in courtyard", environment: "courtyard" },
    composition: { facePosition: "left", faceScale: "very_large", headlineArea: "lower", allowHands: false },
    design_notes: [],
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gudini-cover-"));
}

function stubDeps(qcResults: CoverQcResult[]) {
  const calls = { generated: [] as string[], qc: 0, rendered: 0, encoded: 0 };
  return {
    calls,
    deps: {
      generateImage: async (_p: string, out: string) => {
        calls.generated.push(path.basename(out));
        fs.writeFileSync(out, "png");
        return { cost: 0.068 };
      },
      runQc: async () => qcResults[calls.qc++] ?? qcResults[qcResults.length - 1],
      finish: async (_d: string, src: string, out: string) => {
        fs.copyFileSync(src, out);
        return out;
      },
      renderText: async (_d: string, _b: string, _c: CoverConcept, out: string) => {
        calls.rendered++;
        fs.writeFileSync(out, "jpg");
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

const PASS: CoverQcResult = { status: "PASS", reasons: [], confidence: 0.95, cost: 0.001 };
const EXTRA: CoverQcResult = { status: "EXTRA_TEXT", reasons: ["мусор"], confidence: 0.9, cost: 0.001 };

test("Pipeline 8: первая генерация не прошла QC → один retry → PASS", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, PASS]);
  const r = await buildCover(dir, concept([{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }]), deps);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "FULL_AI");
  assert.equal(r.attempts, 2);
  assert.equal(r.qc, "PASS");
  assert.equal(r.fallbackUsed, false);
  assert.deepEqual(calls.generated, ["cover-attempt-1.png", "cover-attempt-2.png"]);
  assert.ok(fs.existsSync(path.join(dir, "cover-qc-1.json")));
  assert.ok(fs.existsSync(path.join(dir, "cover-qc-2.json")));
  assert.ok(fs.existsSync(path.join(dir, "cover-image-prompt-2.txt")), "retry-промпт должен быть сохранён");
  const retryPrompt = fs.readFileSync(path.join(dir, "cover-image-prompt-2.txt"), "utf8");
  assert.ok(retryPrompt.includes("Previous generation failed"), "retry должен нести feedback");
  assert.equal(r.cost.total, 0.138); // 2 генерации + 2 QC
});

test("Pipeline 9: два провала QC → фолбэк на RENDERER_TEXT с ЧИСТОЙ картинкой", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([EXTRA, EXTRA]);
  const r = await buildCover(dir, concept([{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }]), deps);
  assert.equal(r.ok, true);
  assert.equal(r.fallbackUsed, true);
  assert.equal(calls.rendered, 1, "текст должен положить наш рендерер");
  assert.ok(
    calls.generated.includes("cover-clean-base.png"),
    "фолбэк обязан сгенерировать новую картинку без букв, а не переиспользовать бракованную",
  );
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.fallbackUsed, true);
  assert.equal(mode.selectedMode, "FULL_AI");
});

test("Pipeline 7: QC недоступен → безопасный фолбэк без лишних ретраев", async () => {
  const dir = tmpDir();
  const unavailable: CoverQcResult = { status: "QC_UNAVAILABLE", reasons: ["нет ключа"], confidence: 0, cost: 0 };
  const { deps, calls } = stubDeps([unavailable]);
  const r = await buildCover(dir, concept([{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }]), deps);
  assert.equal(r.ok, true);
  assert.equal(r.fallbackUsed, true);
  assert.equal(calls.qc, 1, "при недоступном QC повторная генерация бессмысленна");
  assert.equal(calls.rendered, 1);
});

test("Pipeline 11: числовой headline → RENDERER_TEXT без Full-AI попыток", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([PASS]);
  const r = await buildCover(dir, concept([{ text: "5000$", accent: false }, { text: "СТАЛИ 300$", accent: "box" }]), deps);
  assert.equal(r.mode, "RENDERER_TEXT");
  assert.equal(r.qc, "SKIPPED");
  assert.equal(calls.qc, 0);
  assert.deepEqual(calls.generated, ["cover-clean-base.png"]);
  assert.equal(calls.rendered, 1);
  assert.ok(r.selectorReasons.length > 0);
});

test("Pipeline 12: короткий headline → FULL_AI с первой попытки", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps([PASS]);
  const r = await buildCover(dir, concept([{ text: "ДЕНЬГИ", accent: false }, { text: "СГОРЕЛИ", accent: "box" }]), deps);
  assert.equal(r.mode, "FULL_AI");
  assert.equal(r.attempts, 1);
  assert.equal(r.qc, "PASS");
  assert.equal(calls.encoded, 1, "в FULL_AI финал без нашего текстового слоя");
  assert.equal(calls.rendered, 0);
});

test("Pipeline: сбой провайдера не роняет монтаж — ok=false с причиной", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps([PASS]);
  deps.generateImage = async () => {
    throw new Error("IMAGE_PROVIDER_ERROR: 429");
  };
  const r = await buildCover(dir, concept([{ text: "ДЕНЬГИ", accent: false }, { text: "СГОРЕЛИ", accent: "box" }]), deps);
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("IMAGE_PROVIDER_ERROR"));
});

test("QC: retry-подсказка называет причину и точные слова", () => {
  const fb = buildRetryFeedback(EXTRA, HEADLINE, KICKER);
  assert.ok(fb.includes("extra readable text"));
  assert.ok(fb.includes(`"${HEADLINE}"`));
  assert.ok(fb.includes("Do not create any other letters"));
});

test("Pipeline 10: FULL_AI_COVER=false выключает новую систему (kill switch)", async () => {
  const { fullAiCoverEnabled, fullAiCoverModel, DEFAULT_FULL_AI_MODEL } = await import("../lib/coverProvider");
  const prev = process.env.FULL_AI_COVER;
  try {
    delete process.env.FULL_AI_COVER;
    assert.equal(fullAiCoverEnabled(), true, "по умолчанию система включена");
    process.env.FULL_AI_COVER = "false";
    assert.equal(fullAiCoverEnabled(), false, "kill switch обязан работать мгновенно");
    assert.equal(fullAiCoverModel(), DEFAULT_FULL_AI_MODEL);
    assert.equal(DEFAULT_FULL_AI_MODEL, "google/gemini-3.1-flash-image", "Pro автоматически не используется");
  } finally {
    if (prev === undefined) delete process.env.FULL_AI_COVER;
    else process.env.FULL_AI_COVER = prev;
  }
});

test("Stats: счётчики различают первый проход, retry и фолбэк", () => {
  let s = readCoverStats(path.join(tmpDir(), "none.json"));
  s = applyCoverRun(s, { mode: "FULL_AI", attempts: 1, qc: "PASS", fallbackUsed: false, cost: 0.069 });
  s = applyCoverRun(s, { mode: "FULL_AI", attempts: 2, qc: "PASS", fallbackUsed: false, cost: 0.138 });
  s = applyCoverRun(s, { mode: "FULL_AI", attempts: 3, qc: "EXTRA_TEXT", fallbackUsed: true, cost: 0.206 });
  s = applyCoverRun(s, { mode: "RENDERER_TEXT", attempts: 1, qc: "SKIPPED", fallbackUsed: false, cost: 0.068 });
  assert.equal(s.totalFullAi, 3);
  assert.equal(s.passFirstTry, 1);
  assert.equal(s.passSecondTry, 1);
  assert.equal(s.fallback, 1);
  assert.equal(s.rendererDirect, 1);
  assert.equal(s.extraText, 1);
  assert.equal(s.totalCost, 0.481);
});
