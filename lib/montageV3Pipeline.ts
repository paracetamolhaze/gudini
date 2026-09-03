import fs from "fs";
import path from "path";
import { StoryResearchPack } from "./storyResearch";
import { buildScriptBeats, ScriptBeat } from "./scriptBeats";
import { buildAssetPack, StoryAssetPackV2 } from "./storyAssetPack";
import { directMontage, MontagePlan } from "./creativeDirector";
import { validateMontage, packReady, montagePreflight, PackDistribution } from "./montageValidator";
import { EditPlan, EditEvent, DEFAULT_CAPTION_STYLE } from "./editPlan";
import { Word } from "./transcribe";

/**
 * Montage V3 как единый производственный шаг.
 *
 * Здесь собран весь путь от истории до готового монтажного плана: блоки
 * сценария, медиатека, режиссёр, валидатор. Вынесено в отдельный модуль,
 * чтобы pipeline.ts вызывал одну функцию, а не повторял порядок стадий.
 *
 * Отката на старый планировщик нет ни на одном шаге. Тихая подмена монтажа
 * однажды уже привела к ролику, собранному непонятно чем: разбираться, почему
 * вышло не то, что задумано, дороже, чем честно упасть.
 */

export type MontageV3Result = {
  plan: EditPlan;
  montage: MontagePlan;
  pack: StoryAssetPackV2;
  beats: ScriptBeat[];
  /** блоки сценария взяты из сохранённых — разбор не оплачивался заново */
  beatsReused: boolean;
  /** медиатека взята готовой, деньги на поиск и зрение не потрачены */
  packReused: boolean;
  /** как визуал распределён по ролику: одной цифры покрытия недостаточно */
  distribution: PackDistribution;
  warnings: string[];
};

/** Переводит события режиссёра в формат, который понимает рендерер. */
export function toEditEvents(montage: MontagePlan, pack: StoryAssetPackV2, mediaDir: string): EditEvent[] {
  const byId = new Map(pack.assets.map((a) => [a.id, a]));
  const out: EditEvent[] = [];
  for (const e of montage.events) {
    const asset = byId.get(e.assetId);
    if (!asset) continue;
    const file = path.join(mediaDir, asset.file);
    if (!fs.existsSync(file)) continue;
    out.push({
      type: "B_ROLL",
      // Раскладка доходит до рендерера явным полем: раньше она терялась здесь,
      // и любой материал всё равно растягивался на весь кадр.
      layout: "top_inset",
      start: e.start,
      end: e.end,
      file,
      entityName: asset.description.slice(0, 80),
      eventName: e.quote.slice(0, 80),
    });
  }
  return out;
}

/**
 * Полный проход V3. Бросает, если стадия не выполнилась: наверху это означает
 * остановку задачи, а не переход на старый монтаж.
 */
export async function runMontageV3(args: {
  research: StoryResearchPack;
  script: string;
  words: Word[];
  duration: number;
  dir: string;
  speechCuts?: number[];
}): Promise<MontageV3Result> {
  const { research, script, words, duration, dir, speechCuts = [] } = args;
  const warnings: string[] = [];

  const { beats, needs, reused: beatsReused } = await buildScriptBeats(script, research, dir);
  const packFile = path.join(dir, "story-asset-pack.json");
  const before = fs.existsSync(packFile) ? fs.statSync(packFile).mtimeMs : 0;

  const pack = await buildAssetPack(research, beats, needs, dir);
  const after = fs.existsSync(packFile) ? fs.statSync(packFile).mtimeMs : 0;
  // файл не переписан — значит вернулся готовый пакет, и поиск со зрением не оплачивались
  const packReused = before > 0 && before === after;

  const ready = packReady(pack);
  if (!ready.ok) warnings.push(...ready.reasons);

  // Режиссёр не создаёт материал, он выбирает из имеющегося. Если распределение
  // заведомо даёт статичное начало или долгий провал, платить за подтверждение
  // очевидного не нужно — сначала доискиваем материал.
  const pre = montagePreflight(pack, beats, duration);
  if (!pre.ok) {
    const err: any = new Error(
      `Медиатеки не хватает на приемлемый темп: ${pre.reasons.join("; ")}. ` +
        "Режиссёр не запускался, деньги не потрачены.",
    );
    err.status = "NEEDS_MORE_MEDIA";
    err.distribution = pre.distribution;
    err.uncoveredBeats = pack.coverage.filter((c) => c.bestScore < 2).map((c) => c.beatId);
    throw err;
  }

  const montage = await directMontage(research, beats, pack, words, duration, speechCuts);
  if (!montage) throw new Error("Режиссёр монтажа не вернул план");

  const check = validateMontage(montage, pack);
  if (check.errors.length) {
    throw new Error(`Монтажный план не прошёл проверку: ${check.errors.join("; ")}`);
  }
  warnings.push(...check.warnings);

  const events = toEditEvents(montage, pack, path.join(dir, "story-assets"));
  const plan: EditPlan = {
    version: 1,
    duration,
    events,
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
  };

  return { plan, montage, pack, beats, beatsReused: Boolean(beatsReused), packReused, distribution: pre.distribution, warnings };
}
