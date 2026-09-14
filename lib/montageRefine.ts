import { computeStats, type MontagePlan, type MontageEvent } from "./creativeDirector";
import type { StoryAssetPackV2 } from "./storyAssetPack";
import type { Word } from "./transcribe";
import { taste } from "./montageTaste";

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

/** Only trim or remove placements. Never invent filler or stretch cards for a coverage quota. */
export function refineMontage(args: {
  montage: MontagePlan; pack: StoryAssetPackV2; beats: RefineBeat[];
  needs: RefineNeed[]; words: Word[]; duration: number;
  personNames?: string[]; speechCuts?: number[];
}): RefineResult {
  const { montage, pack, beats, words, duration } = args;
  const T = taste();
  const starts = beatStarts(beats, words);
  const slots: RefineSlot[] = [];
  beats.forEach((b, i) => {
    const start = starts[i];
    if (start == null) return;
    const end = starts.slice(i + 1).find((s): s is number => s != null) ?? duration;
    slots.push({ beatId: b.id, start, end, need: b.visualNeed, listItem: b.listItem });
  });
  const byId = new Map(pack.assets.map(a => [a.id, a]));
  const used = new Set<string>();
  const families = new Set<string>();
  const events: MontageEvent[] = [];
  const notes: string[] = [];
  for (const e of [...montage.events].sort((a, b) => a.start - b.start)) {
    const asset = byId.get(e.assetId);
    const slot = slots.find(s => s.beatId === e.beatId);
    if (!asset || !slot || slot.need === "NONE" || (asset.beatScores?.[e.beatId] ?? 0) < 2 || used.has(asset.id)) {
      notes.push(`${e.assetId}: нет сильного соответствия текущему блоку — оставлен автор`);
      continue;
    }
    // Same information in different files is still a repeat. Named list items remain separate.
    const family = asset.visualFamily || asset.sceneId || asset.id;
    if (families.has(family) && !slot.listItem) {
      notes.push(`${e.assetId}: повтор той же визуальной информации — оставлен автор`);
      continue;
    }
    const start = Math.max(e.start, slot.start, T.first_visual_after, events.at(-1)?.end ?? 0);
    // One explanation can span adjacent clauses; keep the same image only while
    // it strongly explains every clause, and never cross an author-only passage.
    let meaningEnd = slot.end;
    for (let i = slots.indexOf(slot) + 1; i < slots.length; i++) {
      const next = slots[i];
      if (slot.listItem || next.listItem || next.need === "NONE" || (asset.beatScores?.[next.beatId] ?? 0) < 2) break;
      meaningEnd = next.end;
    }
    const end = Math.min(e.end, meaningEnd, duration, start + (asset.role === "EVENT" ? T.max_exact_event_duration : T.max_visual_duration));
    const min = slot.listItem ? T.min_list_item_duration : T.min_visual_duration;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start + 0.001 < min) continue;
    const spoken = words.filter(w => w.end > start && w.start < end);
    if (spoken.length < 2) continue;
    events.push({ ...e, start, end, quote: spoken.slice(0, 12).map(w => w.word.replace(/[{}\\]/g, "")).join(" ") });
    used.add(asset.id); families.add(family);
  }
  notes.push(`Смысловые вставки: ${montage.events.length} → ${events.length}; паузы с автором сохранены`);
  return { plan: { ...montage, events, stats: computeStats(events, duration, args.speechCuts ?? []) }, slots, notes };
}
