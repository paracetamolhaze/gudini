import { mediaComplete, parseJson, mediaLlmAvailable } from "./mediaLlm";
import { Word } from "./transcribe";
import { StoryResearchPack } from "./storyResearch";
import { ScriptBeat } from "./scriptBeats";
import { StoryAssetPackV2, PackAsset } from "./storyAssetPack";
import { taste } from "./montageTaste";

/** Версия промпта режиссёра: поднимать при изменении текста промпта, иначе сохранённый план переиспользуется. */
export const DIRECTOR_PROMPT_VERSION = 6;
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
  /** Why this image explains this episode and why the picture changes here. */
  visualPurpose?: string;
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

export type RawPlacement = {
  assetId?: string;
  beatId?: string;
  quote?: string;
  seconds?: number;
  visualPurpose?: string;
};

function systemPrompt(): string {
  return `Ты — монтажный режиссёр. Автор говорит в нижней части вертикального ролика.
СВЕРХУ КАРТИНКА ДОЛЖНА БЫТЬ ВСЕГДА: с первого кадра до последнего. Пустых участков нет.
Твоя задача — выстроить непрерывный СМЫСЛОВОЙ видеоряд из неподвижных изображений.

Прочитай ВЕСЬ рассказ и сначала выдели законченные смысловые эпизоды. Выбери картинку,
которая помогает понять каждый эпизод: новый участник, предмет, механизм, действие,
последствие или развязка. Картинка держится, пока развивается соответствующая мысль.
Смена нужна тогда, когда следующая картинка сообщает новую визуальную информацию.
Длительность определяешь ТЫ по смыслу речи, а не программа по таймеру.
Нет нормы «каждые 3 секунды», нет максимума 5 секунд и нет квоты на количество кадров.
Один эпизод может занимать несколько предложений и несколько служебных блоков сценария.

НЕ делай галерею одного объекта: машина спереди → машина сбоку → машина сзади НЕ
объясняет историю. Например, в истории с роботакси зрителю полезно увидеть сам автомобиль
при знакомстве, игрушечное оружие и шарики при их объяснении, пустое водительское место,
камеру/систему наблюдения, связь с полицией, остановку, полицию, развязку. Это примеры
смысловых функций, а НЕ обязательный шаблон и не повод ставить неподходящий материал.

Медиатека конечна. Выбирай лучший честный визуальный опорный образ для ЦЕЛОГО эпизода.
Если нет буквального кадра действия, используй поясняющий предмет, участника или контекст
и объясни в visualPurpose, что именно он помогает понять. Не объявляй иллюстрацию
доказательством события. Не выдумывай интерфейсы, факты или то, чего на картинке нет.
Слабый автоматический балл сопоставления с коротким блоком — повод подумать, а не убрать
картинку. Ты видишь весь рассказ и отвечаешь за смысл окончательного выбора.
Нельзя оставлять только автора; нельзя тянуть случайную фотографию через смену темы.

ФОРМАТ ПЛАНА — точки смены картинки:
- assetId: существующая КАРТИНКА из медиатеки;
- beatId: блок, в котором начинается эпизод (NONE в старой разметке не выключает картинку);
- quote: 2–12 ДОСЛОВНЫХ последовательных слов транскрипции, с которых начинается эпизод;
- visualPurpose: что зритель понимает благодаря этой картинке на ВСЁМ эпизоде и почему
  именно здесь нужна смена относительно предыдущего изображения.

Первая quote начинается с первых слов транскрипции: её картинка появится с нулевой секунды.
Дальше располагай quote строго по порядку речи. Картинка заканчивается ровно в начале
следующей quote; последняя держится до конца. Отдельные seconds НЕ задавай.
Так ты сам выбираешь длительность каждого изображения через смысловую границу смены.
Не делай новую смену ради другого ракурса той же машины. Возврат к прежнему изображению
допустим, если сюжет действительно возвращается к тому же предмету; поясни это.
В перечислении разных людей/предметов переключай на словах о следующем элементе.

Ответь СТРОГО JSON:
{"placements":[{"assetId":"...","beatId":"...","quote":"первые слова текущего эпизода","visualPurpose":"что объясняет кадр и почему смена здесь"}]}`;
}

/** Ищет дословную цитату в словах транскрипции, возвращает индексы. */
export function locateQuote(words: Word[], quote: string): { from: number; to: number } | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const target = norm(quote).split(" ").filter(Boolean);
  if (target.length < 2) return null;
  // A measured word can contain several normalized tokens (e.g. «15-летних»).
  // Preserve its original word index when matching the phrase.
  const flat = words.flatMap((w, wordIndex) => norm(w.word).split(" ").filter(Boolean).map(token => ({ token, wordIndex })));
  for (let i = 0; i + target.length <= flat.length; i++) {
    if (target.every((token, j) => flat[i + j].token === token)) {
      return { from: flat[i].wordIndex, to: flat[i + target.length - 1].wordIndex };
    }
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
      const family = a.visualFamily ? ` одна-информация:${a.visualFamily}` : a.sceneFamily ? ` сцена:${a.sceneFamily}` : "";
      // происхождение видно режиссёру: иллюстрация с сайта или кадр, вырезанный из чужого ролика
      const origin = a.kind === "VIDEO_SEGMENT" ? "ВИДЕО" : /^still-/.test(a.file) ? "КАДР ВИДЕО" : "ИЛЛЮСТРАЦИЯ";
      // заголовок источника называет людей и цифры, которых нет в описании кадра
      // («Nolan's $250M Odyssey…»): без него портрет Нолана шёл под «билеты раскупили»
      const title = a.sourceTitle ? ` · источник: «${a.sourceTitle.slice(0, 70)}»` : "";
      return `id=${a.id} [${origin}/${a.role}]${family} ${scored} — ${a.description.slice(0, 110)}${seg}${title}`;
    })
    .join("\n");
  const beatList = beats
    .map((b) => `[${b.id}] (${b.visualNeed}${b.listItem ? ", СПИСОК" : ""}) ${b.text}`)
    .join("\n");
  const transcript = words.map((w) => w.word).join(" ");

  const raw = await mediaComplete({
    system: systemPrompt(),
    // 24 блока × вставка с цитатой не помещались в 8000: ответ обрезался, деньги уходили
    maxTokens: 16000,
    stage: "Creative Director",
    user:
      `История: ${research.canonicalEvent}\n\n` +
      `Блоки сценария:\n${beatList}\n\n` +
      `Медиатека:\n${catalogue}\n\n` +
      (speechCuts.length
        ? `Склейки речи на ${speechCuts.map((s) => s.toFixed(1)).join(", ")} сек — вставку рядом ставить особенно полезно.\n\n`
        : "") +
      `Не повторяй одну визуальную информацию разными файлами: другой ракурс автомобиля ничего не объясняет. ` +
      `Верх заполнен от начала до конца. Выбирай смысловые эпизоды и точки смены; не оставляй пауз без картинки.\n\n` +
      `Транскрипция (${duration.toFixed(0)} сек):\n${transcript}`,
  });
  addCost({ editPlannerCalls: 1 });

  const placements: RawPlacement[] = parseJson<any>(raw, "Режиссёр монтажа").placements ?? [];
  return planSemanticSequence(placements, pack, words, duration, speechCuts);
}

/** The model chooses every cut through a speech quote; code only resolves its time. */
export function planSemanticSequence(
  placements: RawPlacement[], pack: StoryAssetPackV2, words: Word[], duration: number, speechCuts: number[] = [],
): MontagePlan {
  if (!placements.length) throw new Error("Нужен непрерывный смысловой видеоряд, а не пустой план");
  const byId = new Map(pack.assets.map(a => [a.id, a]));
  const events: MontageEvent[] = [];
  let cursor = 0;
  for (const p of placements) {
    const asset = byId.get(String(p.assetId));
    if (!asset || asset.kind !== "IMAGE") throw new Error(`Неизвестная картинка: ${p.assetId}`);
    const purpose = String(p.visualPurpose ?? "").trim();
    if (!purpose) throw new Error(`${asset.id}: не объяснён смысл изображения и момент смены`);
    const at = locateQuote(words.slice(cursor), String(p.quote ?? ""));
    if (!at) throw new Error(`${asset.id}: цитата смены не найдена в речи: ${p.quote}`);
    const wordIndex = cursor + at.from;
    if (!events.length && wordIndex !== 0) throw new Error("Первая картинка должна сопровождать начало рассказа");
    const start = events.length ? words[wordIndex].start : 0;
    const previous = events.at(-1);
    if (previous && (start <= previous.start || previous.assetId === asset.id)) throw new Error("Новая смена не должна повторять предыдущую картинку или её время");
    if (!Number.isFinite(start) || start >= duration) throw new Error("Смена за пределами ролика");
    if (previous) previous.end = start;
    events.push({ type: "EXTERNAL_IMAGE", assetId: asset.id, beatId: String(p.beatId ?? ""),
      quote: String(p.quote), visualPurpose: purpose, start, end: duration,
      layout: "smart_crop", motion: "static", role: asset.role });
    cursor = wordIndex + 1;
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
