import fs from "fs";
import path from "path";
import type { CoverConcept } from "./cover";
import { buildFullCoverPrompt } from "./coverPrompt";
import { runCoverQc, CoverQcResult, CoverQcStatus } from "./coverQc";
import { generateCoverImage, finishCoverImage, encodeFinalCover, fullAiCoverModel } from "./coverProvider";
import { recordCoverRun } from "./coverStats";

/**
 * Production Cover Pipeline — РОВНО ОДНА платная генерация на одно действие пользователя.
 *
 *   CoverConcept → одна генерация Gemini Flash → QC → PASS или COVER_FAILED
 *
 * Жёсткое правило: 1 user generation action = max 1 paid image generation.
 * QC НИКОГДА не инициирует новую генерацию: при провале обложки просто нет, и только
 * явное нажатие «Перегенерировать» создаёт новый запрос и новую оплату.
 * Автоматических повторов, циклов попыток, retry-feedback, смены модели, рендерера,
 * Runway и кадра из видео в системе не существует.
 */

export type CoverPipelineResult = {
  ok: boolean;
  file?: string; // имя финального файла в папке проекта (только при PASS)
  status: "PASS" | "COVER_FAILED" | "ERROR";
  qc: CoverQcStatus | "NONE";
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
  options: { manual?: boolean } = {},
): Promise<CoverPipelineResult> {
  const d: CoverDeps = { ...defaultDeps, ...deps };
  const headline = concept.headlineLines.map((l) => l.text).join(" ");
  const kicker = concept.kicker ?? null;
  const prompt = buildFullCoverPrompt(concept);

  const cost = { generation: 0, qc: 0, total: 0 };
  let qcStatus: CoverQcStatus | "NONE" = "NONE";

  const finalize = (result: Partial<CoverPipelineResult> & { status: CoverPipelineResult["status"] }) => {
    cost.total = Number((cost.generation + cost.qc).toFixed(6));
    fs.writeFileSync(
      path.join(dir, "cover-mode.json"),
      JSON.stringify(
        {
          mode: "FULL_AI",
          provider: fullAiCoverModel(),
          headline,
          kicker,
          generations: 1,
          automaticRetries: 0,
          manualRegeneration: options.manual === true,
          ...result,
          qc: qcStatus,
          generationCost: Number(cost.generation.toFixed(6)),
          qcCost: Number(cost.qc.toFixed(6)),
          totalCost: cost.total,
        },
        null,
        2,
      ),
      "utf8",
    );
    recordCoverRun({
      status: result.status,
      qc: qcStatus,
      cost: cost.total,
      manual: options.manual === true,
      error: result.reason,
    });
    return { ok: result.status === "PASS", qc: qcStatus, cost, ...result } as CoverPipelineResult;
  };

  fs.writeFileSync(path.join(dir, "cover-prompt.txt"), prompt, "utf8");

  try {
    // ЕДИНСТВЕННЫЙ платный вызов генератора за весь запуск
    const raw = path.join(dir, "cover-attempt-1.png");
    const gen = await d.generateImage(prompt, raw);
    cost.generation += gen.cost ?? 0;

    const qc = await d.runQc(raw, headline, kicker);
    cost.qc += qc.cost ?? 0;
    qcStatus = qc.status;
    fs.writeFileSync(path.join(dir, "cover-qc-1.json"), JSON.stringify(qc, null, 2), "utf8");
    console.log(`Cover QC: ${qc.status}${qc.reasons.length ? ` — ${qc.reasons.join("; ")}` : ""}`);

    if (!qc.pass) {
      console.warn("Cover: COVER_FAILED — автоматическая повторная генерация не выполняется");
      return finalize({
        status: "COVER_FAILED",
        reason: qc.reasons.join("; ") || "обложка не прошла контроль качества",
      });
    }

    // финальная обложка появляется ТОЛЬКО здесь
    const finished = await d.finish(dir, raw, path.join(dir, "cover-final.png"));
    await d.encodeFinal(dir, finished, path.join(dir, COVER_FILE));
    return finalize({ status: "PASS", file: COVER_FILE });
  } catch (e: any) {
    return finalize({ status: "ERROR", reason: String(e?.message ?? e).slice(0, 200) });
  }
}
