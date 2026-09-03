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
  CutRegion,
  CutRegionEdges,
  SpeechCleanupAction,
} from "./speechCleanupPlan";

/**
 * Чистка речи целиком: паузы (тишина + зазоры слов), мусор из расшифровки без
 * модели, план модели, валидация, второй проход по уже чистой транскрипции.
 * Один и тот же путь для production-конвейера и для перечистки готового проекта —
 * иначе «идеально» получается только там, где чинили руками.
 */
export type CleanupRun = {
  cuts: CutRegion[];
  actions: SpeechCleanupAction[];
  /** модель ответила (иначе — только детерминированный мусор и страховка по паузам) */
  llmUsed: boolean;
  secondPass: { fragments: number; pauses: number };
};

export async function planCleanupCuts(args: {
  script: string | null;
  words: Word[];
  silences: SilenceEvent[];
  edges: CutRegionEdges;
  duration: number;
  log?: (line: string) => void;
}): Promise<CleanupRun> {
  const { script, words, silences, edges, duration } = args;
  const log = args.log ?? (() => {});

  // Паузы — тишина по детектору плюс зазоры между словами: вдох детектор не видит.
  const pauses = pausesFromWords(words, silences);
  const llm = await planSpeechCleanup(script, words, pauses);
  // Обрывы «эк--» и «э-э-э» режутся и без модели; если модель недоступна —
  // остаются они и страховочное ужатие длинных пауз.
  const rawActions = [...deterministicFillers(words), ...(llm ?? [])];
  const validated = validateCleanupActions(rawActions, words, pauses, duration);
  let cuts = validated.cuts;
  const actions = [...validated.plan.actions];
  const secondPass = { fragments: 0, pauses: 0 };

  // ВТОРОЙ ПРОХОД: первый редко ловит всё. Смотрим на уже почищенную транскрипцию —
  // повторы через вырезку («и … и»), оставшиеся фальстарты и паузы уже на чистом
  // таймлайне. Режем всё одним разом — исходник перекодируется только один раз.
  if (llm) {
    try {
      const segs1 = segmentsFromCuts(edges, validated.cuts);
      const clean = remapWordsWithIndex(words, segs1);
      const cleanLen = segs1.reduce((n, x) => n + (x.end - x.start), 0);
      const cleanPauses = pausesFromWords(clean.words, []);
      const second = await planSpeechCleanup(script, clean.words, cleanPauses);
      if (second?.length) {
        const fragments = second
          .filter((a) => String(a.type) === "REMOVE_FRAGMENT")
          .map((a) => ({
            ...a,
            fromWord: clean.srcIndex[Math.trunc(Number(a.fromWord))],
            toWord: clean.srcIndex[Math.trunc(Number(a.toWord))],
          }))
          .filter((a) => Number.isFinite(a.fromWord) && Number.isFinite(a.toWord));
        const extra = validateCleanupActions(fragments, words, [], duration);
        // паузы второго прохода валидируются на чистом таймлайне и переводятся в сырое время
        const pauseActs = second.filter((a) => String(a.type) === "SHORTEN_PAUSE");
        const extraPauses = validateCleanupActions(pauseActs, clean.words, cleanPauses, cleanLen);
        const rawPauseCuts = extraPauses.cuts.map((c) => ({ start: cleanToRaw(c.start, segs1), end: cleanToRaw(c.end, segs1) }));
        const rawPauseActs = extraPauses.plan.actions.map((a) => ({ ...a, start: cleanToRaw(a.start, segs1), end: cleanToRaw(a.end, segs1) }));
        if (extra.cuts.length || rawPauseCuts.length) {
          cuts = [...validated.cuts, ...extra.cuts, ...rawPauseCuts];
          actions.push(...extra.plan.actions, ...rawPauseActs);
          secondPass.fragments = extra.cuts.length;
          secondPass.pauses = rawPauseCuts.length;
          log(`Чистка речи, второй проход: +${extra.cuts.length} фрагментов, +${rawPauseCuts.length} пауз`);
        }
      }
    } catch (e) {
      log("Второй проход чистки пропущен: " + String(e).slice(0, 120));
    }
  }
  return { cuts, actions, llmUsed: Boolean(llm), secondPass };
}
