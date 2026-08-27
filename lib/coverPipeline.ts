import fs from "fs";
import path from "path";
import type { CoverConcept } from "./cover";
import { buildFullCoverPrompt } from "./coverPrompt";
import { runCoverQc, buildRetryFeedback, CoverQcResult, CoverQcStatus } from "./coverQc";
import { generateCoverImage, finishCoverImage, encodeFinalCover, fullAiCoverModel } from "./coverProvider";
import { recordCoverRun } from "./coverStats";

/**
 * Production Cover Pipeline — ЕДИНСТВЕННЫЙ режим: FULL_AI.
 *
 *   CoverConcept → Gemini Flash рисует ВСЮ обложку (лицо + сцена + типографика) → QC
 *     PASS → cover.jpg
 *     FAIL → та же модель, тот же концепт и headline + корректирующая инструкция (до 3 попыток)
 *     три FAIL → COVER_FAILED
 *
 * Фолбэков нет вообще: ни детерминированного рендерера, ни Runway, ни кадра из видео,
 * ни другой модели. Повторная генерация — это тот же план A, а не план B.
 * Обложка становится финальной ТОЛЬКО после QC PASS.
 */

export const MAX_COVER_ATTEMPTS = 3;

export type CoverPipelineResult = {
  ok: boolean;
  file?: string; // имя финального файла в папке проекта (только при PASS)
  status: "PASS" | "COVER_FAILED" | "ERROR";
  attempts: number;
  qc: CoverQcStatus | "NONE";
  qcHistory: CoverQcStatus[];
  cost: { generation: number; qc: number; total: number };
  reason?: string;
};

/** Точки подмены для тестов и E2E (в проде — настоящие реализации). */
export type CoverDeps = {
  generateImage: (prompt: string, outFile: string) => Promise<{ cost: number }>;
  runQc: (imageFile: string, headline: string, kicker?: string | null) => Promise<CoverQcResult>;
  finish: (dir: string, source: string, out: string) => Promise<string>;
  encodeFinal: (dir: string, base: string, out: string) => Promise<string>;
};

const defaultDeps: CoverDeps = {
  generateImage: (prompt, outFile) => generateCoverImage(prompt, outFile),
  runQc: (file, headline, kicker) => runCoverQc(file, headline, kicker),
  finish: finishCoverImage,
  encodeFinal: encodeFinalCover,
};

export const COVER_FILE = "cover.jpg";

export async function buildCover(
  dir: string,
  concept: CoverConcept,
  deps: Partial<CoverDeps> = {},
): Promise<CoverPipelineResult> {
  const d: CoverDeps = { ...defaultDeps, ...deps };
  // headline и концепт ФИКСИРУЮТСЯ на весь цикл: между попытками меняется
  // только корректирующая инструкция
  const headline = concept.headlineLines.map((l) => l.text).join(" ");
  const kicker = concept.kicker ?? null;
  const basePrompt = buildFullCoverPrompt(concept);

  const cost = { generation: 0, qc: 0, total: 0 };
  const qcHistory: CoverQcStatus[] = [];
  let attempts = 0;
  let lastQc: CoverQcResult | null = null;

  const finish = (result: Partial<CoverPipelineResult> & { status: CoverPipelineResult["status"] }) => {
    cost.total = Number((cost.generation + cost.qc).toFixed(6));
    const payload = {
      mode: "FULL_AI",
      provider: fullAiCoverModel(),
      headline,
      kicker,
      ...result,
      attempts,
      qc: qcHistory[qcHistory.length - 1] ?? "NONE",
      qcHistory,
      generationCost: Number(cost.generation.toFixed(6)),
      qcCost: Number(cost.qc.toFixed(6)),
      totalCost: cost.total,
    };
    fs.writeFileSync(path.join(dir, "cover-mode.json"), JSON.stringify(payload, null, 2), "utf8");
    recordCoverRun({
      attempts,
      status: result.status,
      qc: qcHistory[qcHistory.length - 1] ?? "NONE",
      cost: cost.total,
      error: result.reason,
    });
    return {
      ok: result.status === "PASS",
      attempts,
      qc: qcHistory[qcHistory.length - 1] ?? ("NONE" as const),
      qcHistory,
      cost,
      ...result,
    } as CoverPipelineResult;
  };

  fs.writeFileSync(path.join(dir, "cover-prompt.txt"), basePrompt, "utf8");

  try {
    for (let attempt = 1; attempt <= MAX_COVER_ATTEMPTS; attempt++) {
      attempts = attempt;
      const prompt = attempt === 1 ? basePrompt : basePrompt + buildRetryFeedback(lastQc!, headline, kicker);
      if (attempt > 1) fs.writeFileSync(path.join(dir, `cover-prompt-${attempt}.txt`), prompt, "utf8");

      const raw = path.join(dir, `cover-attempt-${attempt}.png`);
      const gen = await d.generateImage(prompt, raw);
      cost.generation += gen.cost ?? 0;

      const qc = await d.runQc(raw, headline, kicker);
      cost.qc += qc.cost ?? 0;
      qcHistory.push(qc.status);
      lastQc = qc;
      fs.writeFileSync(
        path.join(dir, `cover-qc-${attempt}.json`),
        JSON.stringify({ attempt, ...qc }, null, 2),
        "utf8",
      );
      console.log(
        `Cover QC #${attempt}/${MAX_COVER_ATTEMPTS}: ${qc.status}${qc.reasons.length ? ` — ${qc.reasons.join("; ")}` : ""}`,
      );

      if (qc.pass) {
        // финальная обложка появляется ТОЛЬКО здесь
        const finished = await d.finish(dir, raw, path.join(dir, "cover-final.png"));
        await d.encodeFinal(dir, finished, path.join(dir, COVER_FILE));
        return finish({ status: "PASS", file: COVER_FILE });
      }
    }

    console.warn(`Cover: COVER_FAILED — ${MAX_COVER_ATTEMPTS} попытки не прошли QC (${qcHistory.join(", ")})`);
    return finish({
      status: "COVER_FAILED",
      reason: lastQc?.reasons.join("; ") || "обложка не прошла контроль качества",
    });
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 200);
    return finish({ status: "ERROR", reason });
  }
}
