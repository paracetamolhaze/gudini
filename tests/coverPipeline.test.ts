import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { detectImageMediaType } from "../lib/mediaLlm";
import { buildCover } from "../lib/coverPipeline";
import { applyCoverRun, readCoverStats } from "../lib/coverStats";
import { acceptKicker } from "../lib/cover";
import type { CoverConcept } from "../lib/cover";

test("Формат картинки определяется по байтам, а не по расширению (баг из E2E)", () => {
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
function stubDeps() {
  const calls = { generated: [] as string[], finished: 0, encoded: 0 };
  return {
    calls,
    deps: {
      generateImage: async (_prompt: string, out: string) => {
        calls.generated.push(path.basename(out));
        fs.writeFileSync(out, "png");
        return { cost: 0.068 };
      },
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

test("Обложка: ровно одна генерация и готовый файл", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps();
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.ok, true);
  assert.equal(r.status, "PASS");
  assert.equal(calls.generated.length, 1);
  assert.equal(calls.encoded, 1);
  assert.ok(fs.existsSync(path.join(dir, "cover.jpg")));
  assert.equal(r.cost.total, 0.068, "оплачена только генерация: проверки в цене больше нет");
});

test("ГЛАВНОЕ: нарисованная картинка всегда становится обложкой", async () => {
  const dir = tmpDir();
  const { deps, calls } = stubDeps();
  const r = await buildCover(dir, TIGER(), deps);
  assert.equal(r.status, "PASS", "автоматического отказа в системе нет");
  assert.equal(r.ok, true);
  assert.equal(r.file, "cover.jpg");
  assert.equal(calls.generated.length, 1, "одно действие пользователя — одна оплата");
  assert.equal(calls.encoded, 1);
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.generations, 1);
  assert.equal(mode.automaticRetries, 0);
  assert.equal("qc" in mode, false, "проверки обложки больше нет — и в отчёте прогона её нет");
  assert.equal(fs.existsSync(path.join(dir, "cover-qc-1.json")), false);
});

test("Ручная перегенерация — это ещё РОВНО одна генерация", async () => {
  const dir = tmpDir();
  // общий счётчик на оба запуска: имитируем нажатие «Перегенерировать» после провала
  const calls = { generated: 0 };
  const deps = {
    generateImage: async (_p: string, out: string) => {
      calls.generated++;
      fs.writeFileSync(out, "png");
      return { cost: 0.068 };
    },
    finish: async (_d: string, src: string, out: string) => (fs.copyFileSync(src, out), out),
    encodeFinal: async (_d: string, _b: string, out: string) => (fs.writeFileSync(out, "jpg"), out),
  };

  const first = await buildCover(dir, TIGER(), deps);
  assert.equal(first.status, "PASS");
  assert.equal(calls.generated, 1, "после автоматического запуска — 1 генерация");

  const second = await buildCover(dir, TIGER(), deps, { manual: true });
  assert.equal(second.status, "PASS");
  assert.equal(calls.generated, 2, "нажатие пользователя добавило ровно одну генерацию");
  const mode = JSON.parse(fs.readFileSync(path.join(dir, "cover-mode.json"), "utf8"));
  assert.equal(mode.manualRegeneration, true);
});

test("В пайплайне нет ни рендерера, ни Runway, ни кадра из видео", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps();
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

test("Артефакты одной попытки", async () => {
  const dir = tmpDir();
  const { deps } = stubDeps();
  await buildCover(dir, TIGER(), deps);
  for (const f of ["cover-prompt.txt", "cover-attempt-1.png", "cover-final.png", "cover.jpg", "cover-mode.json"]) {
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

test("Stats: generated / made / manualRegenerations и никаких счётчиков проверки", () => {
  let s = readCoverStats(path.join(tmpDir(), "none.json"));
  s = applyCoverRun(s, { status: "PASS", cost: 0.068 });
  s = applyCoverRun(s, { status: "ERROR", cost: 0, error: "429" });
  s = applyCoverRun(s, { status: "PASS", cost: 0.068, manual: true });
  assert.equal(s.generated, 3);
  assert.equal(s.made, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.manualRegenerations, 1);
  assert.equal(s.totalCost, 0.136);
  for (const gone of ["passedQc", "failedQc", "extraText", "textMismatch", "qcUnavailable", "fallback"]) {
    assert.equal(gone in s, false, `счётчик ${gone} должен быть удалён`);
  }
});

test("Stats: прежняя цифра passedQc из старого файла становится made", () => {
  const file = path.join(tmpDir(), "cover-stats.json");
  fs.writeFileSync(file, JSON.stringify({ generated: 5, passedQc: 3, failedQc: 2, extraText: 1, totalCost: 0.35 }), "utf8");
  const s = readCoverStats(file);
  assert.equal(s.generated, 5);
  assert.equal(s.made, 3);
  assert.equal("failedQc" in s, false);
});
