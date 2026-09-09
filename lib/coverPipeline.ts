import fs from "fs";
import path from "path";
import type { CoverConcept } from "./cover";
import { buildFullCoverPrompt } from "./coverPrompt";
import { generateCoverImage, finishCoverImage, encodeFinalCover, fullAiCoverModel } from "./coverProvider";
import { recordCoverRun } from "./coverStats";

/**
 * Production Cover Pipeline — РОВНО ОДНА платная генерация на одно действие пользователя.
 *
 *   CoverConcept → одна генерация Gemini Flash → готовая обложка
 *
 * Жёсткое правило: 1 user generation action = max 1 paid image generation.
 * Автоматической проверки обложки нет: что сгенерировалось, то и показывается —
 * решает человек, он же нажимает «Создать заново», и это ещё одна оплата.
 * Автоматических повторов, циклов попыток, retry-feedback, смены модели, рендерера,
 * Runway и кадра из видео в системе не существует.
 */

export type CoverPipelineResult = {
  ok: boolean;
  file?: string; // имя финального файла в папке проекта
  status: "PASS" | "ERROR";
  cost: { generation: number; total: number };
  reason?: string;
};

/** Точки подмены для тестов и E2E (в проде — настоящие реализации). */
export type CoverDeps = {
  generateImage: (prompt: string, outFile: string) => Promise<{ cost: number }>;
  finish: (dir: string, source: string, out: string) => Promise<string>;
  encodeFinal: (dir: string, base: string, out: string) => Promise<string>;
};

const defaultDeps: CoverDeps = {
  generateImage: (prompt, outFile) => generateCoverImage(prompt, outFile),
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

  const cost = { generation: 0, total: 0 };

  const finalize = (result: Partial<CoverPipelineResult> & { status: CoverPipelineResult["status"] }) => {
    cost.total = Number(cost.generation.toFixed(6));
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
          generationCost: Number(cost.generation.toFixed(6)),
          totalCost: cost.total,
        },
        null,
        2,
      ),
      "utf8",
    );
    recordCoverRun({
      status: result.status,
      cost: cost.total,
      manual: options.manual === true,
      error: result.reason,
      headlineWords: headline.split(/\s+/).filter(Boolean).length,
      headlineChars: headline.replace(/\s/g, "").length,
    });
    return { ok: result.status === "PASS", cost, ...result } as CoverPipelineResult;
  };

  fs.writeFileSync(path.join(dir, "cover-prompt.txt"), prompt, "utf8");

  try {
    // ЕДИНСТВЕННЫЙ платный вызов генератора за весь запуск
    const raw = path.join(dir, "cover-attempt-1.png");
    const gen = await d.generateImage(prompt, raw);
    cost.generation += gen.cost ?? 0;

    // Сгенерированная картинка сразу становится обложкой: автоматической проверки нет,
    // потому что она отклоняла годные обложки и оставляла ролик с пометкой «нужна правка».
    // Оценивает человек: обложка видна на шаге «Публикация» рядом с «Создать заново».
    const finished = await d.finish(dir, raw, path.join(dir, "cover-final.png"));
    await d.encodeFinal(dir, finished, path.join(dir, COVER_FILE));
    return finalize({ status: "PASS", file: COVER_FILE });
  } catch (e: any) {
    return finalize({ status: "ERROR", reason: String(e?.message ?? e).slice(0, 200) });
  }
}
