import fs from "node:fs";
import path from "node:path";
import type { AstraInput } from "../src/input";
import { askAstra, extractCode, type BridgeImage } from "./bridge";
import { draftImages, keyMoments } from "./frames";
import { makeCutouts } from "./matting";
import { fixPrompt, reviewPrompt, systemPrompt, taskPrompt, type Task } from "./prompt";
import { renderVideo } from "./render";
import sharp from "sharp";
import { listMemes, redrawScene, resolveAssets, type PhotoPicker } from "./assets";
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
  /** The owner's meme library (video clips by file name). */
  memesDir?: string;
  /** Checked facts of the story (who, what, where), so pictures show what really happened. */
  facts?: string[];
  /** Continue from a montage Astra already wrote (and reviewed), without asking her again. */
  startCode?: string;
  skipReview?: boolean;
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
  const task: Task = { topic: job.topic, input, lessons: job.lessons, memes: Object.keys(listMemes(job.memesDir)), facts: job.facts };
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
    let assetRounds = 0;
    for (let attempt = 1; ; attempt++) {
      const analysis = analyzeMontage(code, input.duration);
      const errors = typecheck(prepareWorkspace(code, `${path.basename(outDir)}-check-${label}-${attempt}`));
      const problems = [...analysis.problems, ...errors];
      let missing: string[] = [];
      if (!problems.length) {
        // Emoji, logos and photos the montage asks for are fetched now; what cannot be found goes back to Astra once.
        const needs = assetNeeds(analysis.blocks);
        // On the second round, photos that still do not fit are drawn from what should be visible on them.
        const resolved = await resolveAssets(needs, publicDir, job.assetCache ?? "asset-cache", {
          pick: pickPhotos, memesDir: job.memesDir, drawMissingPhotos: assetRounds >= 1, rescue: rescueScene,
          video: path.join(publicDir, input.video), face: input.face,
        });
        input = { ...input, assets: { ...input.assets, ...resolved.assets }, sizes: { ...input.sizes, ...resolved.sizes } };
        missing = resolved.missing;
        log(`Материалы: логотипы ${needs.logos.length}, фото ${needs.photos.length}, сцены ${needs.scenes.length}, превращения ${needs.morphs.length}, мемы ${needs.memes.length}; не нашлось ${missing.length}`);
      }
      fs.writeFileSync(path.join(outDir, `${label}-analysis-${attempt}.json`), JSON.stringify({ ...analysis, errors, problems, missing }, null, 2));
      // A photo that still cannot be found is shown by its fallback emoji (or skipped): the montage goes on.
      if (!problems.length && (!missing.length || assetRounds >= 1)) {
        if (missing.length) log(`Без картинки остались: ${missing.length} — эти места пропущены`);
        return { code, analysis };
      }
      if (!problems.length) assetRounds++;
      problems.push(...missing);
      log(`Проверка: ${problems.length} проблем(ы): ${problems.slice(0, 3).join(" | ")}`);
      if (attempt >= 3) throw new Error(`Астра: монтаж не собирается после ${attempt} попыток: ${problems.slice(0, 5).join("; ")}`);
      code = await ask(`${label}-fix-${attempt}`, fixPrompt(task, code, problems));
    }
  };

  /** A scene the image generator refused is rewritten by Astra so it can be generated, keeping its meaning. */
  const rescueScene = async (prompt: string, error: string): Promise<string | null> => {
    const user = [
      "Генератор картинок не сделал сцену для ролика.", `Ошибка: ${error}`, "", "Сцена:", prompt, "",
      "Перепиши описание так, чтобы генератор его принял, и сохрани смысл истории: кто участвует и сколько их, что у них в руках, что происходит, где.",
      "Что обычно помогает: несовершеннолетних показывать со спины, в профиль или издалека, без крупных лиц; у игрушечного оружия подчеркнуть, что это игрушка (яркий оранжевый наконечник, прозрачный магазин с цветными шариками); действие показать через его результат (шарики летят из окна).",
      "Ответ — только новое описание сцены по-английски, одним абзацем.",
    ].join("\n");
    log(`Астра переписывает сцену для генератора: ${prompt.slice(0, 60)}...`);
    try {
      const result = await askAstra("Ты — Астра, монтажёр. Помогаешь генератору картинок сделать сцену для ролика.", user);
      return result.text.trim().replace(/^```\w*\n?|```$/g, "").trim() || null;
    } catch { return null; }
  };

  /** Astra looks at stock photo candidates and picks the one that shows the thing clearly. */
  const pickPhotos: PhotoPicker = async (sets) => {
    const images: BridgeImage[] = [];
    const lines: string[] = [];
    for (const set of sets) set.previews.forEach((buffer, index) => {
      if (!buffer.length || images.length >= 24) return;
      images.push({ base64: buffer.toString("base64"), mediaType: buffer[0] === 0x89 ? "image/png" : "image/jpeg" });
      lines.push(`${images.length}. запрос «${set.query}»${set.look ? ` (должно быть видно: ${set.look})` : ""}, вариант ${index}`);
    });
    const user = [
      "Для монтажа нужны фото. К заданию приложены варианты в таком порядке:", lines.join("\n"), "",
      "Для каждого запроса выбери вариант, на котором видно всё, что указано в «должно быть видно». Если чего-то из этого на фото нет (например, шариков рядом с бластером) — вариант не подходит, выбери -1: тогда эту сцену нарисуют.",
      "Надписи на самих предметах — нормально (POLICE на форме, марка на бутылке). Не подходят водяные знаки, коллажи, другой предмет, тёмные и размытые фото.",
      `Ответ — только JSON вида {"запрос": номер варианта}.`,
    ].join("\n");
    log(`Астра выбирает фото: ${sets.length} запрос(ов), ${images.length} вариантов...`);
    const result = await askAstra("Ты — Астра, монтажёр. Выбираешь фото для вставок в ролик.", user, images);
    try { return JSON.parse(result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1)); } catch { return {}; }
  };

  /**
   * Astra looks at every prepared picture next to what it must show. What is wrong is drawn again
   * with the problem spelled out; a photo that fails is replaced by a generated scene.
   */
  const verifyPictures = async (analysis: ReturnType<typeof analyzeMontage>) => {
    const needs = assetNeeds(analysis.blocks);
    const wanted: { key: string; need: string; redraw: string }[] = [
      ...needs.scenes.map(prompt => ({ key: `scene:${prompt}`, need: prompt, redraw: prompt })),
      ...needs.photos.map(query => ({ key: `photo:${query}`, need: needs.looks[query] ?? query, redraw: needs.looks[query] ?? query })),
      ...needs.morphs.map(m => ({ key: `morph:${m.from.toFixed(2)}`, need: `автор в той же позе и комнате превращён в ${m.into}`, redraw: "" })),
    ].filter(w => input.assets[w.key]).slice(0, 20);
    if (!wanted.length) return;
    const images: BridgeImage[] = [];
    for (const w of wanted) {
      const file = path.join(publicDir, input.assets[w.key]);
      const meta = await sharp(file).metadata();
      const tall = (meta.width ?? 1) / (meta.height ?? 1) <= 0.85;
      // Exactly the part of a tall picture that fills the screen; a wide one is shown whole.
      const buffer = await (tall && !w.key.startsWith("morph:") ? sharp(file).resize(450, 800, { fit: "cover" }) : sharp(file).resize(560, 700, { fit: "inside" })).jpeg({ quality: 82 }).toBuffer();
      images.push({ base64: buffer.toString("base64"), mediaType: "image/jpeg" });
    }
    const user = [
      "Перед рендером проверь картинки, которые войдут в ролик. Каждая показана ровно так, как её увидит зритель на экране телефона.",
      "Для каждой ответь, показывает ли она требуемое: нужные участники и их число, нужные предметы (пистолет — это пистолет, а не автомат), действие, место.",
      "Хорошая картинка похожа на настоящее фото и читается с первого взгляда. Мультяшность, лишние люди, другой предмет или обрезанный главный объект — это ошибка.",
      "", ...wanted.map((w, i) => `${i + 1}. должно быть: ${w.need}`), "",
      `Ответ — только JSON: {"1": {"ok": true}, "2": {"ok": false, "problem": "что не так, одной фразой по-английски"}}`,
    ].join("\n");
    log(`Астра проверяет картинки: ${wanted.length}...`);
    const result = await askAstra("Ты — Астра, монтажёр. Проверяешь картинки для ролика перед рендером.", user, images);
    let verdicts: Record<string, { ok?: boolean; problem?: string }> = {};
    try { verdicts = JSON.parse(result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1)); } catch { return; }
    fs.writeFileSync(path.join(outDir, `pictures-check-${Date.now()}.json`), JSON.stringify({ wanted, verdicts }, null, 2));
    for (const [index, w] of wanted.entries()) {
      const verdict = verdicts[String(index + 1)];
      if (!verdict || verdict.ok !== false || !w.redraw) continue;
      log(`Перерисовка ${w.key.slice(0, 60)}: ${verdict.problem ?? ""}`);
      const redrawn = await redrawScene(w.redraw, verdict.problem ?? "it did not show the described scene", publicDir, job.assetCache ?? "asset-cache");
      if (redrawn) input = { ...input, assets: { ...input.assets, [w.key]: redrawn.file }, sizes: redrawn.size ? { ...input.sizes, [w.key]: redrawn.size } : input.sizes };
    }
  };

  const cutouts = (analysis: ReturnType<typeof analyzeMontage>) => {
    const ranges = cutoutRanges(analysis.blocks, input.duration);
    log(`Вырезка автора: ${ranges.map(r => `${r.from.toFixed(1)}–${r.to.toFixed(1)}`).join(", ") || "не нужна"}`);
    return makeCutouts({ video: path.join(publicDir, input.video), publicDir, subdir: `${job.mediaSubdir}/cutouts`, ranges });
  };

  job.onStage?.("write");
  let { code, analysis } = await settle(job.startCode ?? await ask("montage-v1", taskPrompt(task)), "v1");
  await verifyPictures(analysis);
  job.onStage?.("cutout");
  input = { ...input, cutouts: cutouts(analysis) };

  const draft = path.join(outDir, "draft.mp4");
  if (!job.skipReview) {
    log("Черновой рендер...");
    job.onStage?.("draft", 0);
    await renderVideo({ workspace: prepareWorkspace(code, `${path.basename(outDir)}-draft`), publicDir, input, out: draft, scale: 0.5,
      onProgress: f => job.onStage?.("draft", f) });
    job.onStage?.("review");
    const { images, labels } = draftImages(draft, path.join(outDir, "draft-frames"), keyMoments(analysis.blocks, input.duration), input.duration);
    ({ code, analysis } = await settle(await ask("montage-review", reviewPrompt(task, code, labels, analysis.notes), images), "review"));
    await verifyPictures(analysis);
    input = { ...input, cutouts: cutouts(analysis) };
  }
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
