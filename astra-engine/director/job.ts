import fs from "node:fs";
import path from "node:path";
import type { AstraInput } from "../src/input";
import { askAstra, extractCode, type BridgeImage } from "./bridge";
import { draftImages, keyMoments } from "./frames";
import { makeCutouts } from "./matting";
import { fixPrompt, reviewPrompt, systemPrompt, taskPrompt, type Task } from "./prompt";
import { renderVideo } from "./render";
import { resolveAssets, type PhotoPicker } from "./assets";
import { analyzeMontage, assetNeeds, cutoutRanges } from "./validate";
import { prepareWorkspace, typecheck } from "./workspace";

export type MontageJob = {
  input: AstraInput;
  topic: string;
  lessons: string[];
  /** Bundle public folder: fonts, the author video, sounds; cutouts are written here too. */
  publicDir: string;
  /** Subfolder of publicDir for this job's cutouts. */
  mediaSubdir: string;
  /** Where prompts, answers, versions of the montage and renders are kept. */
  outDir: string;
  /** Subfolder of publicDir where fetched emoji, logos and photos are cached between jobs. */
  assetCache?: string;
  log?: (line: string) => void;
  onStage?: (stage: "write" | "cutout" | "draft" | "review" | "final", fraction?: number) => void;
};

export type MontageResult = { code: string; input: AstraInput; draft: string; final: string };

/**
 * Astra edits one video end to end: writes the montage, fixes what does not build,
 * cuts the author out for text-behind shots, renders a draft, looks at it, renders the final.
 */
export async function directMontage(job: MontageJob): Promise<MontageResult> {
  const { outDir, publicDir } = job;
  fs.mkdirSync(outDir, { recursive: true });
  const log = (line: string) => { job.log?.(line); fs.appendFileSync(path.join(outDir, "log.txt"), `${new Date().toISOString()} ${line}\n`); };
  let input: AstraInput = { ...job.input, cutouts: [] };
  const task: Task = { topic: job.topic, input, lessons: job.lessons };
  const system = systemPrompt();
  fs.writeFileSync(path.join(outDir, "system.md"), system);

  const ask = async (label: string, user: string, images: BridgeImage[] = []) => {
    fs.writeFileSync(path.join(outDir, `${label}.prompt.md`), user);
    log(`Астра: ${label}${images.length ? ` (кадров: ${images.length})` : ""}...`);
    const started = Date.now();
    const result = await askAstra(system, user, images);
    log(`Астра ответила за ${((Date.now() - started) / 1000).toFixed(0)} с (вход ${result.usage.inputTokens}, выход ${result.usage.outputTokens} токенов)`);
    const code = extractCode(result.text);
    fs.writeFileSync(path.join(outDir, `${label}.tsx`), code);
    return code;
  };

  const settle = async (code: string, label: string) => {
    for (let attempt = 1; ; attempt++) {
      const analysis = analyzeMontage(code, input.duration);
      const errors = typecheck(prepareWorkspace(code, `${path.basename(outDir)}-check-${label}-${attempt}`));
      const problems = [...analysis.problems, ...errors];
      if (!problems.length) {
        // Emoji, logos and photos the montage asks for are fetched now; what cannot be found goes back to Astra.
        const needs = assetNeeds(analysis.blocks);
        const resolved = await resolveAssets(needs, publicDir, job.assetCache ?? "asset-cache", pickPhotos);
        input = { ...input, assets: { ...input.assets, ...resolved.assets } };
        log(`Материалы: эмодзи ${needs.emoji.length}, логотипы ${needs.logos.length}, фото ${needs.photos.length}; не нашлось ${resolved.missing.length}`);
        problems.push(...resolved.missing);
      }
      fs.writeFileSync(path.join(outDir, `${label}-analysis-${attempt}.json`), JSON.stringify({ ...analysis, errors, problems }, null, 2));
      if (!problems.length) return { code, analysis };
      log(`Проверка: ${problems.length} проблем(ы): ${problems.slice(0, 3).join(" | ")}`);
      if (attempt >= 3) throw new Error(`Астра: монтаж не собирается после ${attempt} попыток: ${problems.slice(0, 5).join("; ")}`);
      code = await ask(`${label}-fix-${attempt}`, fixPrompt(task, code, problems));
    }
  };

  /** Astra looks at stock photo candidates and picks the one that shows the thing clearly. */
  const pickPhotos: PhotoPicker = async (sets) => {
    const images: BridgeImage[] = [];
    const lines: string[] = [];
    for (const set of sets) set.previews.forEach((buffer, index) => {
      if (!buffer.length || images.length >= 24) return;
      images.push({ base64: buffer.toString("base64"), mediaType: buffer[0] === 0x89 ? "image/png" : "image/jpeg" });
      lines.push(`${images.length}. запрос «${set.query}», вариант ${index}`);
    });
    const user = [
      "Для монтажа нужны фото. К заданию приложены варианты в таком порядке:", lines.join("\n"), "",
      "Для каждого запроса выбери вариант, где предмет виден ясно, крупно и без чужих надписей; -1 — если ни один не подходит.",
      `Ответ — только JSON вида {"запрос": номер варианта}.`,
    ].join("\n");
    log(`Астра выбирает фото: ${sets.length} запрос(ов), ${images.length} вариантов...`);
    const result = await askAstra("Ты — Астра, монтажёр. Выбираешь фото для вставок в ролик.", user, images);
    try { return JSON.parse(result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1)); } catch { return {}; }
  };

  const cutouts = (analysis: ReturnType<typeof analyzeMontage>) => {
    const ranges = cutoutRanges(analysis.blocks, input.duration);
    log(`Вырезка автора: ${ranges.map(r => `${r.from.toFixed(1)}–${r.to.toFixed(1)}`).join(", ") || "не нужна"}`);
    return makeCutouts({ video: path.join(publicDir, input.video), publicDir, subdir: `${job.mediaSubdir}/cutouts`, ranges });
  };

  job.onStage?.("write");
  let { code, analysis } = await settle(await ask("montage-v1", taskPrompt(task)), "v1");
  job.onStage?.("cutout");
  input = { ...input, cutouts: cutouts(analysis) };

  const draft = path.join(outDir, "draft.mp4");
  log("Черновой рендер...");
  job.onStage?.("draft", 0);
  await renderVideo({ workspace: prepareWorkspace(code, `${path.basename(outDir)}-draft`), publicDir, input, out: draft, scale: 0.5,
    onProgress: f => job.onStage?.("draft", f) });
  job.onStage?.("review");
  const { images, labels } = draftImages(draft, path.join(outDir, "draft-frames"), keyMoments(analysis.blocks, input.duration), input.duration);
  ({ code, analysis } = await settle(await ask("montage-review", reviewPrompt(task, code, labels, analysis.notes), images), "review"));
  input = { ...input, cutouts: cutouts(analysis) };
  fs.writeFileSync(path.join(outDir, "Montage.tsx"), code);
  fs.writeFileSync(path.join(outDir, "input.json"), JSON.stringify(input));

  log("Финальный рендер...");
  const final = path.join(outDir, "final.mp4");
  let last = -1;
  job.onStage?.("final", 0);
  await renderVideo({
    workspace: prepareWorkspace(code, `${path.basename(outDir)}-final`), publicDir, input, out: final,
    onProgress: f => {
      job.onStage?.("final", f);
      const p = Math.floor(f * 10) * 10;
      if (p !== last) { last = p; log(`рендер ${p}%`); }
    },
  });
  log(`Готово: ${final}`);
  return { code, input, draft, final };
}
