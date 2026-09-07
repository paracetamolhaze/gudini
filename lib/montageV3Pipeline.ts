import fs from "fs";
import path from "path";
import { StoryResearchPack } from "./storyResearch";
import { buildScriptBeats, ScriptBeat, MediaResearchNeed } from "./scriptBeats";
import { buildAssetPack, StoryAssetPackV2 } from "./storyAssetPack";
import { directMontage, MontagePlan, DIRECTOR_PROMPT_VERSION } from "./creativeDirector";
import { textHash } from "./fileFingerprint";
import { taste } from "./montageTaste";
import { refineMontage } from "./montageRefine";
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
  /** режиссёрский план взят из director-plan.json — режиссёр не оплачивался */
  directorReused: boolean;
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
    // в карточку идут только картинки — видеофайл здесь означает старый пакет
    if (asset.kind !== "IMAGE") throw new Error(`${asset.id}: в карточку попал ${asset.kind}, разрешены только изображения`);
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

export const DIRECTOR_PLAN_FILE = "director-plan.json";

/**
 * Ключ режиссёрского плана: всё, от чего зависит ответ модели. Совпал — план
 * берётся из файла, и повтор после ошибки рендера, проверки или доставки не
 * платит режиссёру второй раз. Одного наличия файла недостаточно.
 */
export function directorPlanKey(args: {
  research: StoryResearchPack;
  beats: ScriptBeat[];
  pack: StoryAssetPackV2;
  words: Word[];
  duration: number;
  speechCuts: number[];
}): string {
  const { research, beats, pack, words, duration, speechCuts } = args;
  return textHash(
    JSON.stringify({
      v: DIRECTOR_PROMPT_VERSION,
      story: research.storyId ?? research.canonicalEvent,
      facts: research.facts.map((f) => f.id),
      beats,
      pack: [pack.fingerprint ?? "", pack.createdAt ?? "", pack.assets.map((a) => [a.id, a.compatibleBeatIds, a.role, a.beatScores ?? null])],
      words: words.map((w) => [w.word, Math.round(w.start * 100), Math.round(w.end * 100)]),
      duration: Math.round(duration * 100),
      cuts: speechCuts.map((c) => Math.round(c * 100)),
      taste: taste(),
      model: process.env.MEDIA_LLM_MODEL ?? "",
    }),
  );
}

export function loadDirectorPlan(dir: string, key: string): MontagePlan | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, DIRECTOR_PLAN_FILE), "utf8"));
    if (j?.key === key && Array.isArray(j?.plan?.events)) return j.plan as MontagePlan;
  } catch {}
  return null;
}

export function saveDirectorPlan(dir: string, key: string, plan: MontagePlan): void {
  fs.writeFileSync(
    path.join(dir, DIRECTOR_PLAN_FILE),
    JSON.stringify({ key, createdAt: new Date().toISOString(), plan }, null, 2),
    "utf8",
  );
}

/**
 * Полный проход V3. Бросает, если стадия не выполнилась: наверху это означает
 * остановку задачи, а не переход на старый монтаж.
 */
export type PreparedLibrary = {
  beats: ScriptBeat[];
  needs: MediaResearchNeed[];
  beatsReused: boolean;
  pack: StoryAssetPackV2;
  packReused: boolean;
};

/**
 * Блоки сценария и медиатека: зависят только от сценария и исследования, поэтому
 * могут собираться параллельно с чисткой речи и перекодированием (минус ~2 минуты).
 */
export async function prepareLibrary(research: StoryResearchPack, script: string, dir: string): Promise<PreparedLibrary> {
  const { beats, needs, reused: beatsReused } = await buildScriptBeats(script, research, dir);
  const packFile = path.join(dir, "story-asset-pack.json");
  const before = fs.existsSync(packFile) ? fs.statSync(packFile).mtimeMs : 0;
  const pack = await buildAssetPack(research, beats, needs, dir);
  const after = fs.existsSync(packFile) ? fs.statSync(packFile).mtimeMs : 0;
  // файл не переписан — значит вернулся готовый пакет, и поиск со зрением не оплачивались
  const packReused = before > 0 && before === after;
  return { beats, needs, beatsReused: Boolean(beatsReused), pack, packReused };
}

export async function runMontageV3(args: {
  research: StoryResearchPack;
  script: string;
  words: Word[];
  duration: number;
  dir: string;
  speechCuts?: number[];
  /** медиатека, собранная заранее параллельно с чисткой речи */
  prepared?: PreparedLibrary;
}): Promise<MontageV3Result> {
  const { research, script, words, duration, dir, speechCuts = [] } = args;
  const warnings: string[] = [];

  const packFile = path.join(dir, "story-asset-pack.json");
  const { beats, needs, beatsReused, pack, packReused } = args.prepared ?? (await prepareLibrary(research, script, dir));

  const ready = packReady(pack);
  if (!ready.ok) warnings.push(...ready.reasons);

  // Режиссёр не создаёт материал, он выбирает из имеющегося. Если распределение
  // заведомо даёт статичное начало или долгий провал, платить за подтверждение
  // очевидного не нужно — сначала доискиваем материал.
  const pre = montagePreflight(pack, beats, duration);
  if (!pre.ok) {
    // Медиатека, не прошедшая проверку темпа, не должна переиспользоваться: после
    // провала два запуска подряд брали её из кэша и падали за секунду, не собрав
    // ничего заново. Файл остаётся рядом для разбора, следующий запуск соберёт новую.
    try {
      fs.renameSync(packFile, path.join(dir, "story-asset-pack.failed.json"));
    } catch {}
    const err: any = new Error(
      `Медиатеки не хватает на приемлемый темп: ${pre.reasons.join("; ")}. Режиссёр не запускался` +
        (packReused
          ? "; медиатека была взята из кэша и сброшена — следующий запуск соберёт её заново."
          : "; сборка медиатеки уже оплачена, следующий запуск соберёт её заново."),
    );
    err.status = "NEEDS_MORE_MEDIA";
    err.distribution = pre.distribution;
    err.uncoveredBeats = pack.coverage.filter((c) => c.bestScore < 2).map((c) => c.beatId);
    throw err;
  }

  const planKey = directorPlanKey({ research, beats, pack, words, duration, speechCuts });
  const savedPlan = loadDirectorPlan(dir, planKey);
  const directorReused = Boolean(savedPlan);
  if (directorReused) console.log("Режиссёрский план переиспользован — режиссёр не оплачивался");
  const directed = savedPlan ?? (await directMontage(research, beats, pack, words, duration, speechCuts));
  if (!directed) throw new Error("Режиссёр монтажа не вернул план");

  // Уплотнение по блокам: режиссёр отдаёт валидный, но грубый темп (вставки по 6 с
  // подряд, 16 с на одной картинке). Детерминированно, без второго вызова.
  const refined = refineMontage({
    montage: directed,
    pack,
    beats,
    needs,
    words,
    duration,
    personNames: research.entities.filter((e) => e.type === "PERSON").map((e) => e.name),
  });
  for (const n of refined.notes) console.log("Уплотнение: " + n);
  const montage = refined.plan;

  const check = validateMontage(montage, pack);
  if (check.errors.length) {
    throw new Error(`Монтажный план не прошёл проверку: ${check.errors.join("; ")}`);
  }
  warnings.push(...check.warnings);
  // сохраняется только план, прошедший проверку: негодный план не должен переиспользоваться
  if (!directorReused) saveDirectorPlan(dir, planKey, directed);

  const events = toEditEvents(montage, pack, path.join(dir, "story-assets"));
  const plan: EditPlan = {
    version: 1,
    duration,
    events,
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
  };

  return { plan, montage, pack, beats, beatsReused, packReused, directorReused, distribution: pre.distribution, warnings };
}
