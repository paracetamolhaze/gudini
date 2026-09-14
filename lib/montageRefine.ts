import { computeStats, type MontagePlan } from "./creativeDirector";
import type { StoryAssetPackV2 } from "./storyAssetPack";
import type { Word } from "./transcribe";

export type RefineBeat = { id: string; text: string; visualNeed: string; listItem?: boolean };
export type RefineNeed = { beatId: string; intent?: string; entities?: string[]; visualDescription: string };
export type RefineSlot = { beatId: string; start: number; end: number; need: string; listItem?: boolean };
export type RefineResult = { plan: MontagePlan; slots: RefineSlot[]; notes: string[] };
const skeleton = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
function sameStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) <= 4 || Math.abs(a.length - b.length) > 3) return false;
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n >= Math.max(3, Math.min(a.length, b.length) - 2);
}
/** Align complete beats, including author-only passages, with the spoken words. */
export function beatStarts(beats: RefineBeat[], words: Word[]): (number | null)[] {
  const sk = words.map(w => skeleton(w.word));
  let j = 0;
  return beats.map(b => {
    const toks = String(b.text).split(/\s+/).map(skeleton).filter(t => t.length >= 4).slice(0, 5);
    if (!toks.length) return null;
    const lim = Math.min(words.length, j + 80);
    let hit = -1;
    for (const head of toks.slice(0, 2)) {
      for (let k = j; k < lim && hit < 0; k++) {
        if (!sameStem(sk[k], head)) continue;
        let found = 0;
        for (let m = k; m < Math.min(words.length, k + 8); m++) if (toks.some(t => sameStem(sk[m], t))) found++;
        if (found >= Math.min(2, toks.length)) hit = k;
      }
      if (hit >= 0) break;
    }
    if (hit < 0) return null;
    j = hit + 1;
    return words[hit].start;
  });
}

/** Preserve the model's semantic episodes; never remove cards or cut them on a timer. */
export function refineMontage(args: {
  montage: MontagePlan; pack: StoryAssetPackV2; beats: RefineBeat[];
  needs: RefineNeed[]; words: Word[]; duration: number;
  personNames?: string[]; speechCuts?: number[];
}): RefineResult {
  const { montage, beats, words, duration } = args;
  const starts = beatStarts(beats, words);
  const slots: RefineSlot[] = [];
  beats.forEach((b, i) => {
    const start = starts[i];
    if (start == null) return;
    const end = starts.slice(i + 1).find((s): s is number => s != null) ?? duration;
    slots.push({ beatId: b.id, start, end, need: b.visualNeed, listItem: b.listItem });
  });
  const events = montage.events.map(e => ({ ...e }));
  return { plan: { ...montage, events, stats: computeStats(events, duration, args.speechCuts ?? []) }, slots,
    notes: [`Смысловые эпизоды режиссёра: ${events.length}; моменты смены и длительности сохранены`] };
}
