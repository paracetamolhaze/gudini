import fs from "fs";
import path from "path";
import type { CoverConcept } from "./cover";
import { buildFullCoverPrompt, buildCoverImagePromptFull } from "./coverPrompt";
import { selectTypographyMode, CoverTypographyMode } from "./coverTypography";
import { runCoverQc, buildRetryFeedback, CoverQcResult, CoverQcStatus } from "./coverQc";
import {
  generateCoverImage,
  finishCoverImage,
  renderHeadlineOnImage,
  encodeFinalCover,
  fullAiCoverModel,
} from "./coverProvider";
import { recordCoverRun } from "./coverStats";

/**
 * Hybrid Cover Pipeline (production).
 *
 *   concept → headline simplification (в планировщике) → Typography Mode Selector
 *     ├─ FULL_AI       : Gemini Flash рисует обложку целиком → QC Gate
 *     │                    PASS → final
 *     │                    FAIL → ОДИН retry с feedback → QC
 *     │                             FAIL → фолбэк на RENDERER_TEXT
 *     └─ RENDERER_TEXT : Gemini Flash рисует FACE+SCENE без букв → наш рендерер
 *
 * Опубликована может быть только валидная обложка: непрошедшая QC картинка никогда
 * не становится основой финала (под нарисованным мусором текст остался бы виден) —
 * для фолбэка всегда генерируется ЧИСТОЕ изображение без букв.
 */

export type CoverPipelineResult = {
  ok: boolean;
  file?: string; // имя финального файла в папке проекта
  mode: CoverTypographyMode;
  selectorReasons: string[];
  attempts: number;
  qc: CoverQcStatus | "SKIPPED";
  fallbackUsed: boolean;
  cost: { generation: number; qc: number; total: number };
  reason?: string;
};

/** Точки подмены для тестов и E2E (в проде — настоящие реализации). */
export type CoverDeps = {
  generateImage: (prompt: string, outFile: string) => Promise<{ cost: number }>;
  runQc: (imageFile: string, headline: string, kicker?: string) => Promise<CoverQcResult>;
  finish: (dir: string, source: string, out: string) => Promise<string>;
  renderText: (dir: string, base: string, concept: CoverConcept, out: string) => Promise<string>;
  encodeFinal: (dir: string, base: string, out: string) => Promise<string>;
};

const defaultDeps: CoverDeps = {
  generateImage: (prompt, outFile) => generateCoverImage(prompt, outFile),
  runQc: (file, headline, kicker) => runCoverQc(file, headline, kicker),
  finish: finishCoverImage,
  renderText: renderHeadlineOnImage,
  encodeFinal: encodeFinalCover,
};

const FINAL = "cover.jpg";
const MAX_FULL_AI_ATTEMPTS = 2; // одна генерация + один retry, дальше — фолбэк

export async function buildCover(
  dir: string,
  concept: CoverConcept,
  deps: Partial<CoverDeps> = {},
): Promise<CoverPipelineResult> {
  const d: CoverDeps = { ...defaultDeps, ...deps };
  const headline = concept.headlineLines.map((l) => l.text).join(" ");
  const choice = selectTypographyMode(concept.headlineLines);
  const cost = { generation: 0, qc: 0, total: 0 };
  let attempts = 0;
  let qcStatus: CoverQcStatus | "SKIPPED" = "SKIPPED";
  let fallbackUsed = false;

  const writeMode = (result: Partial<CoverPipelineResult>) => {
    cost.total = Number((cost.generation + cost.qc).toFixed(6));
    const payload = {
      selectedMode: choice.mode,
      selectorReasons: choice.reasons,
      provider: fullAiCoverModel(),
      attempts,
      qc: qcStatus,
      fallbackUsed,
      generationCost: Number(cost.generation.toFixed(6)),
      qcCost: Number(cost.qc.toFixed(6)),
      totalCost: cost.total,
      ...result,
    };
    fs.writeFileSync(path.join(dir, "cover-mode.json"), JSON.stringify(payload, null, 2), "utf8");
  };

  try {
    if (choice.mode === "FULL_AI") {
      const basePrompt = buildFullCoverPrompt(concept);
      fs.writeFileSync(path.join(dir, "cover-image-prompt.txt"), basePrompt, "utf8");
      let lastQc: CoverQcResult | null = null;

      for (let attempt = 1; attempt <= MAX_FULL_AI_ATTEMPTS; attempt++) {
        attempts = attempt;
        const prompt =
          attempt === 1 ? basePrompt : basePrompt + buildRetryFeedback(lastQc!, headline, concept.kicker);
        if (attempt > 1) fs.writeFileSync(path.join(dir, "cover-image-prompt-2.txt"), prompt, "utf8");

        const raw = path.join(dir, `cover-attempt-${attempt}.png`);
        const gen = await d.generateImage(prompt, raw);
        cost.generation += gen.cost ?? 0;

        const qc = await d.runQc(raw, headline, concept.kicker);
        cost.qc += qc.cost ?? 0;
        qcStatus = qc.status;
        lastQc = qc;
        fs.writeFileSync(
          path.join(dir, `cover-qc-${attempt}.json`),
          JSON.stringify({ attempt, ...qc }, null, 2),
          "utf8",
        );
        console.log(
          `Cover QC #${attempt}: ${qc.status}${qc.reasons.length ? ` — ${qc.reasons.join("; ")}` : ""}`,
        );

        if (qc.status === "PASS") {
          const finished = await d.finish(dir, raw, path.join(dir, "cover_base.png"));
          await d.encodeFinal(dir, finished, path.join(dir, FINAL));
          const result = { ok: true, file: FINAL };
          writeMode(result);
          recordCoverRun({ mode: "FULL_AI", attempts, qc: qc.status, fallbackUsed: false, cost: cost.total });
          return { ...result, mode: choice.mode, selectorReasons: choice.reasons, attempts, qc: qcStatus, fallbackUsed, cost };
        }

        // QC недоступен — retry не поможет, сразу к гарантированному пути
        if (qc.status === "QC_UNAVAILABLE") break;
      }

      // два провала (или недоступный QC) → чистая картинка без букв + наш рендерер
      fallbackUsed = true;
      console.warn(`Cover: Full-AI не прошёл QC (${qcStatus}) — фолбэк на детерминированный рендерер`);
    }

    // --- RENDERER_TEXT: изображение БЕЗ букв + детерминированный текстовый слой ---
    const cleanPrompt = buildCoverImagePromptFull(concept);
    fs.writeFileSync(path.join(dir, "cover-clean-prompt.txt"), cleanPrompt, "utf8");
    const clean = path.join(dir, "cover-clean-base.png");
    const gen = await d.generateImage(cleanPrompt, clean);
    cost.generation += gen.cost ?? 0;
    attempts += 1;

    const finished = await d.finish(dir, clean, path.join(dir, "cover_base.png"));
    await d.renderText(dir, finished, concept, path.join(dir, FINAL));

    const result = { ok: true, file: FINAL };
    writeMode(result);
    recordCoverRun({
      mode: fallbackUsed ? "FULL_AI" : "RENDERER_TEXT",
      attempts,
      qc: qcStatus,
      fallbackUsed,
      cost: cost.total,
    });
    return { ...result, mode: choice.mode, selectorReasons: choice.reasons, attempts, qc: qcStatus, fallbackUsed, cost };
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 200);
    writeMode({ ok: false, reason });
    recordCoverRun({ mode: choice.mode, attempts, qc: qcStatus, fallbackUsed, cost: cost.total, error: reason });
    return { ok: false, mode: choice.mode, selectorReasons: choice.reasons, attempts, qc: qcStatus, fallbackUsed, cost, reason };
  }
}
