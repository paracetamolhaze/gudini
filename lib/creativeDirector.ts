import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { Word } from "./transcribe";
import { StoryResearchPack } from "./storyResearch";
import { ScriptBeat } from "./scriptBeats";
import { StoryAssetPackV2, PackAsset } from "./storyAssetPack";
import { taste } from "./montageTaste";
import { addCost } from "./pipelineCost";

/**
 * Creative Director — режиссёр монтажа поверх готовой медиатеки.
 *
 * Он НИЧЕГО не ищет: выбирает только из проверенного пакета. Идея из
 * talking-head-autoeditor: каждое событие обязано нести ДОСЛОВНУЮ цитату из
 * транскрипции — так режиссёр не может «придумать» момент, которого в речи нет,
 * а таймкоды мы потом ставим сами по измеренным словам, не доверяя модели.
 *
 * Один смысловой блок может закрываться последовательностью из 2–3 коротких
 * кадров (человек → событие → последствие) — это даёт динамику без подмены смысла.
 */

const MODEL = "claude-sonnet-5";

export type MontageEventType = "EXTERNAL_VIDEO" | "EXTERNAL_IMAGE";
export type Layout = "fullscreen" | "smart_crop" | "fit_blurred";
export type ImageMotion = "static" | "slow_push" | "slow_pan_left" | "slow_pan_right";

export type MontageEvent = {
  type: MontageEventType;
  assetId: string;
  beatId: string;
  /** дословная цитата речи, которую перекрывает вставка */
  quote: string;
  start: number;
  end: number;
  layout: Layout;
  motion?: ImageMotion;
  role: PackAsset["role"];
};

export type MontagePlan = {
  version: 3;
  duration: number;
  events: MontageEvent[];
  stats: {
    externalCoverage: number;
    videoShare: number;
    maxARollGap: number;
    speechCutsCovered: number;
    speechCutsTotal: number;
  };
};

type RawPlacement = {
  assetId?: string;
  beatId?: string;
  quote?: string;
  seconds?: number;
};

function systemPrompt(): string {
  const T = taste();
  return `Ты — режиссёр монтажа коротких вертикальных видео. Автор читает текст на камеру.
У тебя ЕСТЬ готовая медиатека проверенных материалов этой истории. Искать ничего не нужно
и нельзя: доступны только материалы из списка, по их id.

Задача — расставить материалы поверх речи так, чтобы визуал менялся каждые ${Math.round(T.typical_visual_duration)}–4 секунды,
а зритель всё время видел то, о чём идёт речь.

ЖЁСТКИЕ ПРАВИЛА:
1. Для каждой вставки укажи quote — ДОСЛОВНЫЙ фрагмент транскрипции из 4–12 слов подряд,
   который эта вставка перекрывает. Копируй слова точно, без изменений. Если не можешь
   найти точную цитату — не ставь вставку.
2. assetId — только из списка медиатеки.
3. Один материал используется ОДИН раз. Разные сегменты одного видео — разные материалы.
4. seconds — желаемая длительность: ${T.min_visual_duration}–${T.max_visual_duration}, обычно ${T.typical_visual_duration}.
5. Один смысловой блок можно закрыть ПОСЛЕДОВАТЕЛЬНОСТЬЮ из 2–3 коротких вставок
   (участник → событие → последствие). Это лучше, чем один длинный кадр.
6. Материал с ролью CONTEXT не выдавай за само событие: ставь его туда, где речь об обстановке.
   Роль EXACT_EVENT/EVENT ставь на фразу о самом происшествии.
7. Первые 2 секунды ролика — лицо автора, туда вставок не ставь.
8. Если под фразу в медиатеке нет ничего подходящего — не ставь ничего. Лицо автора лучше
   неподходящего кадра.

Ответь СТРОГО валидным JSON:
{"placements":[{"assetId":"...","beatId":"...","quote":"дословные слова из транскрипции","seconds":2.7}]}`;
}

/** Ищет дословную цитату в словах транскрипции, возвращает индексы. */
export function locateQuote(words: Word[], quote: string): { from: number; to: number } | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const target = norm(quote).split(" ").filter(Boolean);
  if (target.length < 2) return null;
  const flat = words.map((w) => norm(w.word));

  for (let i = 0; i + target.length <= flat.length; i++) {
    let hit = true;
    for (let j = 0; j < target.length; j++) {
      if (flat[i + j] !== target[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return { from: i, to: i + target.length - 1 };
  }
  // мягкий поиск: достаточно первых трёх слов подряд
  const head = target.slice(0, 3);
  for (let i = 0; i + head.length <= flat.length; i++) {
    if (head.every((t, j) => flat[i + j] === t)) return { from: i, to: Math.min(flat.length - 1, i + target.length - 1) };
  }
  return null;
}

/** Выбирает раскладку кадра по его пропорциям. */
export function chooseLayout(width: number, height: number, kind: "VIDEO_SEGMENT" | "IMAGE"): Layout {
  if (!width || !height) return "smart_crop";
  const aspect = width / height;
  if (aspect <= 0.75) return "fullscreen"; // уже вертикальный
  if (aspect < 1.35) return "smart_crop"; // почти квадрат — обрезаем безопасно
  return kind === "IMAGE" ? "smart_crop" : "fit_blurred";
}

/**
 * Строит монтажный план. Таймкоды ставим САМИ по измеренным словам —
 * модели доверяем только выбор материала и цитату.
 */
export async function directMontage(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  pack: StoryAssetPackV2,
  words: Word[],
  duration: number,
  speechCuts: number[] = [],
): Promise<MontagePlan | null> {
  const key = getSettings().anthropicKey;
  if (!key || !pack.assets.length || words.length < 10) return null;
  const T = taste();

  const catalogue = pack.assets
    .map((a) => {
      const seg = a.segment ? ` (фрагмент ${a.segment.start.toFixed(0)}–${a.segment.end.toFixed(0)}с)` : "";
      return `id=${a.id} [${a.kind === "VIDEO_SEGMENT" ? "ВИДЕО" : "ФОТО"}/${a.role}] блоки: ${a.compatibleBeatIds.join(",")} — ${a.description.slice(0, 110)}${seg}`;
    })
    .join("\n");
  const beatList = beats
    .filter((b) => b.visualNeed !== "NONE")
    .map((b) => `[${b.id}] (${b.visualNeed}) ${b.text}`)
    .join("\n");
  const transcript = words.map((w) => w.word).join(" ");

  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt(),
    messages: [
      {
        role: "user",
        content:
          `История: ${research.canonicalEvent}\n\n` +
          `Блоки сценария:\n${beatList}\n\n` +
          `Медиатека:\n${catalogue}\n\n` +
          (speechCuts.length
            ? `Склейки речи на ${speechCuts.map((s) => s.toFixed(1)).join(", ")} сек — вставку рядом ставить особенно полезно.\n\n`
            : "") +
          `Транскрипция (${duration.toFixed(0)} сек):\n${transcript}`,
      },
    ],
  });
  addCost({ editPlannerCalls: 1 });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();

  let placements: RawPlacement[];
  try {
    placements = JSON.parse(raw).placements ?? [];
  } catch {
    return null;
  }

  const byId = new Map(pack.assets.map((a) => [a.id, a]));
  const used = new Set<string>();
  const events: MontageEvent[] = [];

  const located = placements
    .map((p) => {
      const asset = byId.get(String(p.assetId));
      if (!asset || used.has(asset.id)) return null;
      const at = locateQuote(words, String(p.quote ?? ""));
      if (!at) return null;
      return { p, asset, at };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.at.from - b.at.from);

  let prevEnd = -Infinity;
  for (const { p, asset, at } of located) {
    const startRaw = words[at.from]?.start;
    if (!Number.isFinite(startRaw)) continue;
    const start = Math.max(startRaw, prevEnd + 0.12);
    if (start < 1.8) continue; // открывающая фраза остаётся лицом автора

    const wanted = Number(p.seconds);
    const cap = asset.role === "EVENT" ? T.max_exact_event_duration : T.max_visual_duration;
    let len = Number.isFinite(wanted) ? wanted : T.typical_visual_duration;
    len = Math.min(cap, Math.max(T.min_visual_duration, len));
    const end = Math.min(start + len, duration - 0.05);
    if (end - start < T.min_visual_duration * 0.8) continue;

    used.add(asset.id);
    events.push({
      type: asset.kind === "VIDEO_SEGMENT" ? "EXTERNAL_VIDEO" : "EXTERNAL_IMAGE",
      assetId: asset.id,
      beatId: String(p.beatId ?? asset.compatibleBeatIds[0] ?? ""),
      quote: String(p.quote ?? "").slice(0, 120),
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      layout: "smart_crop",
      motion: asset.kind === "IMAGE" ? (T.image_motion === "subtle" ? "slow_push" : "static") : undefined,
      role: asset.role,
    });
    prevEnd = end;
  }

  return { version: 3, duration, events, stats: computeStats(events, duration, speechCuts) };
}

export function computeStats(events: MontageEvent[], duration: number, speechCuts: number[]): MontagePlan["stats"] {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  let external = 0;
  let video = 0;
  let cursor = 0;
  let maxGap = 0;
  for (const e of sorted) {
    const from = Math.max(e.start, cursor);
    if (e.end > from) {
      external += e.end - from;
      if (e.type === "EXTERNAL_VIDEO") video += e.end - from;
    }
    if (e.start - cursor > maxGap) maxGap = e.start - cursor;
    cursor = Math.max(cursor, e.end);
  }
  if (duration - cursor > maxGap) maxGap = duration - cursor;
  const covered = speechCuts.filter((t) => sorted.some((e) => e.start <= t + 0.05 && e.end >= t - 0.05)).length;
  return {
    externalCoverage: duration ? Number((external / duration).toFixed(3)) : 0,
    videoShare: external ? Number((video / external).toFixed(3)) : 0,
    maxARollGap: Number(maxGap.toFixed(2)),
    speechCutsCovered: covered,
    speechCutsTotal: speechCuts.length,
  };
}
