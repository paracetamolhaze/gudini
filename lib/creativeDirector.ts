import { mediaComplete, parseJson, mediaLlmAvailable } from "./mediaLlm";
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
  return `Ты — режиссёр монтажа коротких вертикальных видео. Автор читает текст на камеру,
и он ВИДЕН ПОЧТИ ВСЁ ВРЕМЯ: его лицо — главный слой ролика.

Внешние материалы — ТОЛЬКО НЕПОДВИЖНЫЕ КАРТИНКИ. Каждая показывается одинаковой
карточкой в верхней части кадра, поверх автора — как подпись к тому, о чём он
сейчас говорит. Размер и положение карточки задаёт программа, тебе о них думать
не нужно: ты решаешь только ЧТО показать и НА КАКИХ СЛОВАХ.

С момента первой карточки и до конца ролика сверху ВСЕГДА должна быть какая-то
картинка: одна напрямую сменяет другую. Если под следующую мысль подходящей
картинки нет, предыдущая просто держится дольше — это сделает программа. Твоё
дело — расставить смены там, где меняется мысль или объект рассказа.

У тебя ЕСТЬ готовая медиатека проверенных материалов этой истории. Искать ничего
не нужно и нельзя: доступны только материалы из списка, по их id.

Задача — вести иллюстрацию почти непрерывно: зритель должен всё время видеть
то, о чём идёт речь, а визуал — меняться вместе с новой мыслью или новым
объектом рассказа.

ЖЁСТКИЕ ПРАВИЛА:
1. Для каждой вставки укажи quote — ДОСЛОВНЫЙ фрагмент транскрипции из 4–12 слов
   подряд, который эта вставка сопровождает. Копируй слова точно, без изменений.
   Если не можешь найти точную цитату — не ставь вставку.
2. assetId — только из списка медиатеки.
3. Один материал используется ОДИН раз. Разные сегменты одного видео — разные материалы.
4. seconds — желаемая длительность: ${T.min_visual_duration}–${T.max_visual_duration}, обычно ${T.typical_visual_duration}.
5. Первые ${T.first_visual_after} секунды — только лицо автора. Первую карточку поставь
   сразу после вступительной фразы, не позже ${T.first_visual_by} секунды.
6. Один смысловой блок можно закрыть ПОСЛЕДОВАТЕЛЬНОСТЬЮ из 2–3 вставок
   (участник → событие → последствие). Соседние вставки могут идти встык.
7. Не оставляй длинных участков совсем без иллюстрации: ориентир — не больше
   ${T.max_aroll_gap} секунд подряд.
8. Для ролика в минуту нужно примерно 12–18 смен картинки, каждая держится
   3–5 секунд. Меняй картинку с новой мыслью, а не по таймеру.
9. У каждого материала показаны оценки совместимости с блоками (b3=3 значит
   «точно про этот блок»). Бери 3, затем 2. Оценку 1 ставь только если под эту
   фразу нет ничего лучше.
10. Если под фразу в медиатеке нет ПОДХОДЯЩЕГО материала — не ставь ничего.
    Лицо автора лучше неподходящего кадра. Заполнять таймлайн ради процента нельзя.

Ответь СТРОГО валидным JSON:
{"placements":[{"assetId":"...","beatId":"...","quote":"дословные слова из транскрипции","seconds":3.6}]}`;
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
/** Каждая картинка держится до начала следующей, последняя — до конца ролика. */
export function chainTimeline(events: MontageEvent[], duration: number): void {
  events.sort((a, b) => a.start - b.start);
  for (let i = 0; i < events.length; i++) {
    const next = events[i + 1];
    events[i].end = Number((next ? next.start - 1 / 30 : duration).toFixed(3));
  }
}

/**
 * Уплотнение долгих удержаний.
 *
 * Продлить предыдущую картинку честно только тогда, когда подходящей новой НЕТ.
 * Режиссёр же оставлял одно фото на двенадцать секунд, хотя под те же блоки в
 * медиатеке лежали неиспользованные материалы с оценкой 2–3. Здесь такие
 * удержания делятся ещё не показанными картинками тех же блоков — без нового
 * вызова модели: выбор из уже сопоставленного делает код.
 */
export function densifyTimeline(
  events: MontageEvent[],
  pack: StoryAssetPackV2,
  beats: ScriptBeat[],
  duration: number,
): void {
  const T = taste();
  const longest = T.max_visual_duration * 1.6;
  const used = new Set(events.map((e) => e.assetId));
  const beatIndex = new Map(beats.map((b, i) => [b.id, i]));
  const byId = new Map(pack.assets.map((a) => [a.id, a]));

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const hold = e.end - e.start;
    if (hold <= longest) continue;
    const next = events[i + 1];
    // блоки, которые этот участок покрывает: от блока картинки до блока следующей
    const from = beatIndex.get(e.beatId) ?? 0;
    const to = next ? (beatIndex.get(next.beatId) ?? beats.length) : beats.length;
    const span = beats.slice(Math.min(from, to), Math.max(from, to) + 1).map((b) => b.id);
    const current = byId.get(e.assetId);
    const candidates = pack.assets
      .filter((a) => !used.has(a.id) && a.kind === "IMAGE")
      .map((a) => ({ a, score: Math.max(0, ...span.map((b) => a.beatScores?.[b] ?? 0)) }))
      .filter((c) => c.score >= 2 && (!current?.sceneFamily || c.a.sceneFamily !== current.sceneFamily || c.score === 3))
      .sort((x, y) => y.score - x.score);
    if (!candidates.length) continue;
    const extra = Math.min(candidates.length, 3, Math.floor(hold / T.typical_visual_duration) - 1);
    if (extra < 1) continue;
    const step = hold / (extra + 1);
    for (let k = 1; k <= extra; k++) {
      const pick = candidates[k - 1].a;
      used.add(pick.id);
      events.push({
        type: "EXTERNAL_IMAGE",
        assetId: pick.id,
        beatId: pick.compatibleBeatIds.find((b) => span.includes(b)) ?? e.beatId,
        quote: e.quote,
        start: Number((e.start + step * k).toFixed(3)),
        end: Number((e.start + step * (k + 1)).toFixed(3)),
        layout: "smart_crop",
        motion: "static",
        role: pick.role,
      });
    }
    e.end = Number((e.start + step).toFixed(3));
    events.sort((a, b) => a.start - b.start);
  }
  chainTimeline(events, duration);
}

export async function directMontage(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  pack: StoryAssetPackV2,
  words: Word[],
  duration: number,
  speechCuts: number[] = [],
): Promise<MontagePlan | null> {
  if (!mediaLlmAvailable()) {
    throw new Error("Режиссёр монтажа не запущен: нет доступного LLM-провайдера");
  }
  if (!pack.assets.length) throw new Error("Режиссёр монтажа не запущен: медиатека пуста");
  if (words.length < 10) throw new Error("Режиссёр монтажа не запущен: транскрипция слишком короткая");
  const T = taste();

  const catalogue = pack.assets
    .map((a) => {
      const seg = a.segment ? ` (фрагмент ${a.segment.start.toFixed(0)}–${a.segment.end.toFixed(0)}с)` : "";
      // оценки по блокам показываем прямо в каталоге: без них режиссёр не знает,
      // где материал точен, а где годится лишь как обстановка
      const scored = a.compatibleBeatIds
        .map((b) => `${b}=${a.beatScores?.[b] ?? "?"}`)
        .join(" ");
      const family = a.sceneFamily ? ` сцена:${a.sceneFamily}` : "";
      return `id=${a.id} [${a.kind === "VIDEO_SEGMENT" ? "ВИДЕО" : "ФОТО"}/${a.role}]${family} ${scored} — ${a.description.slice(0, 110)}${seg}`;
    })
    .join("\n");
  const beatList = beats
    .filter((b) => b.visualNeed !== "NONE")
    .map((b) => `[${b.id}] (${b.visualNeed}) ${b.text}`)
    .join("\n");
  const transcript = words.map((w) => w.word).join(" ");

  const raw = await mediaComplete({
    system: systemPrompt(),
    maxTokens: 8000,
    stage: "Creative Director",
    user:
      `История: ${research.canonicalEvent}\n\n` +
      `Блоки сценария:\n${beatList}\n\n` +
      `Медиатека:\n${catalogue}\n\n` +
      (speechCuts.length
        ? `Склейки речи на ${speechCuts.map((s) => s.toFixed(1)).join(", ")} сек — вставку рядом ставить особенно полезно.\n\n`
        : "") +
      `Транскрипция (${duration.toFixed(0)} сек):\n${transcript}`,
  });
  addCost({ editPlannerCalls: 1 });

  const placements: RawPlacement[] = parseJson<any>(raw, "Режиссёр монтажа").placements ?? [];

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
  let prevScene: string | undefined;
  for (const { p, asset, at } of located) {
    const startRaw = words[at.from]?.start;
    if (!Number.isFinite(startRaw)) continue;
    const start = Math.max(startRaw, prevEnd + 0.12);
    if (start < 1.8) continue; // открывающая фраза остаётся лицом автора

    // Два почти одинаковых плана подряд читаются как застрявшая картинка,
    // даже если это формально разные фрагменты разного времени.
    const scene = asset.sceneId;
    if (scene && scene === prevScene) continue;

    // Если под блок есть точный материал, слабая обстановка не ставится:
    // выбор «1» при наличии «3» — это потеря смысла без всякой выгоды.
    const beatId = String(p.beatId ?? asset.compatibleBeatIds[0] ?? "");
    const myScore = asset.beatScores?.[beatId] ?? 2;
    const bestForBeat = pack.coverage.find((c) => c.beatId === beatId)?.bestScore ?? myScore;
    if (myScore <= 1 && bestForBeat >= 3) continue;

    const wanted = Number(p.seconds);
    const cap = asset.role === "EVENT" ? T.max_exact_event_duration : T.max_visual_duration;
    let len = Number.isFinite(wanted) ? wanted : T.typical_visual_duration;
    len = Math.min(cap, Math.max(T.min_visual_duration, len));
    const end = Math.min(start + len, duration - 0.05);
    if (end - start < T.min_visual_duration * 0.8) continue;

    // Верхняя карточка — только картинка. Видео в медиатеке нового формата нет,
    // а если старый пакет его подсунул — это ошибка данных, а не повод показать.
    if (asset.kind !== "IMAGE") {
      throw new Error(`Материал ${asset.id} — не картинка (${asset.kind}); карточка принимает только изображения`);
    }
    used.add(asset.id);
    events.push({
      type: "EXTERNAL_IMAGE",
      assetId: asset.id,
      beatId,
      quote: String(p.quote ?? "").slice(0, 120),
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      layout: "smart_crop",
      motion: asset.kind === "IMAGE" ? (T.image_motion === "subtle" ? "slow_push" : "static") : undefined,
      role: asset.role,
    });
    prevEnd = end;
    prevScene = scene;
  }

  // Непрерывная дорожка: каждая картинка держится до начала следующей, последняя —
  // до конца ролика. Пустых промежутков после первой карточки быть не должно;
  // продлить проверенную картинку честнее, чем показать пустой верх.
  events.sort((a, b) => a.start - b.start);
  // Первая карточка появляется сразу после вступительной фразы. Если модель
  // поставила её позже допустимого, начало сдвигается детерминированно: зрителю
  // важно, что картинка есть, а не что она совпала с конкретным словом.
  if (events.length && events[0].start > T.first_visual_by) {
    events[0].start = Number(Math.max(T.first_visual_after, T.first_visual_by).toFixed(3));
  }
  chainTimeline(events, duration);
  densifyTimeline(events, pack, beats, duration);
  chainTimeline(events, duration);

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
