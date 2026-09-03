import { Word } from "./transcribe";
import { SilenceEvent } from "./ffmpeg";
import { planSpeechCleanup } from "./speechCleanupPlanner";
import {
  validateCleanupActions,
  segmentsFromCuts,
  remapWordsWithIndex,
  pausesFromWords,
  deterministicFillers,
  cleanToRaw,
  rawToClean,
  CutRegion,
  CutRegionEdges,
  SpeechCleanupAction,
  RawCleanupAction,
} from "./speechCleanupPlan";
import { selectTakes } from "./takeSelection";

/**
 * Чистка речи целиком, один путь для конвейера и для перечистки готового проекта:
 *  0) сборка по сценарию — лишние попытки прочитать предложение вырезаются без
 *     модели и без предела на длину (дубли проверены по тексту сценария);
 *  1) мусор, видимый в самой расшифровке (обрывы «эк--», «э-э-э») — без модели;
 *  2) модель на уже сокращённой расшифровке: повторы, фальстарты, паузы —
 *     два прохода, второй смотрит на результат первого.
 * Все вырезки в итоге — в сыром времени исходника: перекодирование одно.
 */
export type CleanupRun = {
  cuts: CutRegion[];
  actions: SpeechCleanupAction[];
  /** модель ответила (иначе — только детерминированные шаги и страховка по паузам) */
  llmUsed: boolean;
  takes: { sentences: number; coverage: number; dropped: number; seconds: number };
  passes: { fragments: number; pauses: number }[];
};

type Planner = (script: string | null, words: Word[], silences: SilenceEvent[]) => Promise<RawCleanupAction[] | null>;

export async function planCleanupCuts(args: {
  script: string | null;
  words: Word[];
  silences: SilenceEvent[];
  edges: CutRegionEdges;
  duration: number;
  log?: (line: string) => void;
  /** подмена модели в тестах */
  planner?: Planner;
}): Promise<CleanupRun> {
  const { script, words, silences, edges, duration } = args;
  const log = args.log ?? (() => {});
  const planner = args.planner ?? planSpeechCleanup;
  const cuts: CutRegion[] = [];
  const actions: SpeechCleanupAction[] = [];
  const takesInfo = { sentences: 0, coverage: 0, dropped: 0, seconds: 0 };
  const passes: { fragments: number; pauses: number }[] = [];

  // 0) дубли по сценарию
  if (script) {
    const takes = selectTakes(script, words);
    takesInfo.sentences = takes.sentences.length;
    takesInfo.coverage = takes.coverage;
    if (takes.actions.length) {
      const v = validateCleanupActions(takes.actions, words, [], duration, { removedCap: Infinity, maxRetakeSec: 120, maxRetakeWords: 400 });
      cuts.push(...v.cuts);
      actions.push(...v.plan.actions);
      takesInfo.dropped = v.cuts.length;
      takesInfo.seconds = v.cuts.reduce((n, c) => n + (c.end - c.start), 0);
    }
    log(
      `Сборка по сценарию: предложений ${takes.sentences.length}, найдено прочтений ${(takes.coverage * 100).toFixed(0)}%, ` +
        `лишних попыток вырезано ${takesInfo.dropped} (${takesInfo.seconds.toFixed(1)}с)`,
    );
  }

  // 1) обрывы и протянутые «э-э-э» — по самой расшифровке
  const fillers = validateCleanupActions(deterministicFillers(words), words, [], duration, { removedCap: Infinity });
  cuts.push(...fillers.cuts);
  actions.push(...fillers.plan.actions);

  // 2) модель — на сокращённой расшифровке; её ответы переводятся в сырое время
  const pass = async (label: string): Promise<boolean> => {
    const segs = segmentsFromCuts(edges, cuts);
    const clean = remapWordsWithIndex(words, segs);
    const cleanLen = segs.reduce((n, x) => n + (x.end - x.start), 0);
    const mappedSilences = silences
      .map((s) => ({ start: rawToClean(s.start, segs), end: rawToClean(s.end, segs) }))
      .filter((s) => s.end - s.start >= 0.3);
    const cleanPauses = pausesFromWords(clean.words, mappedSilences);
    const llm = await planner(script, clean.words, cleanPauses);
    if (!llm) return false;
    const fragments = llm
      .filter((a) => String(a.type) === "REMOVE_FRAGMENT")
      .map((a) => ({
        ...a,
        fromWord: clean.srcIndex[Math.trunc(Number(a.fromWord))],
        toWord: clean.srcIndex[Math.trunc(Number(a.toWord))],
      }))
      .filter((a) => Number.isFinite(a.fromWord) && Number.isFinite(a.toWord));
    const vf = validateCleanupActions(fragments, words, [], duration);
    const pauseActs = llm.filter((a) => String(a.type) === "SHORTEN_PAUSE");
    const vp = validateCleanupActions(pauseActs, clean.words, cleanPauses, cleanLen);
    const rawPauseCuts = vp.cuts.map((c) => ({ start: cleanToRaw(c.start, segs), end: cleanToRaw(c.end, segs) }));
    const rawPauseActs = vp.plan.actions.map((a) => ({ ...a, start: cleanToRaw(a.start, segs), end: cleanToRaw(a.end, segs) }));
    cuts.push(...vf.cuts, ...rawPauseCuts);
    actions.push(...vf.plan.actions, ...rawPauseActs);
    passes.push({ fragments: vf.cuts.length, pauses: rawPauseCuts.length });
    log(`Чистка речи, ${label}: +${vf.cuts.length} фрагментов, +${rawPauseCuts.length} пауз`);
    return true;
  };
  let llmUsed = false;
  try {
    llmUsed = await pass("первый проход");
    if (llmUsed) await pass("второй проход");
  } catch (e) {
    if (!llmUsed) throw e;
    log("Второй проход чистки пропущен: " + String(e).slice(0, 120));
  }
  return { cuts, actions, llmUsed, takes: takesInfo, passes };
}
