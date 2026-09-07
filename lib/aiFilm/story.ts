import { mediaComplete, parseJson } from "../mediaLlm";
import type { Word } from "../transcribe";
import type { StoryBible, FilmEpisode } from "./types";

/**
 * Разбор истории для AI-фильма.
 *
 * Вход — чистая речь автора со временем каждого слова (после чистки), сценарий и
 * краткая справка исследования. Выход — Story Bible (герой, места, предметы, стиль,
 * правила непрерывности) и эпизоды: не по предложениям, а по смыслу, 5–10 секунд,
 * каждый с действием в кадре и состоянием после него. Модель получает предложения
 * с номерами и временем и указывает границы эпизодов номерами предложений — так
 * тайминг остаётся точным, а модель думает про смысл, не про секунды.
 */

export const STORY_MODEL = process.env.AI_FILM_STORY_MODEL || "claude-sonnet-5";
export const STORY_VERSION = 1;

export type Sentence = { index: number; start: number; end: number; text: string };

/** Предложения из слов чистого таймлайна: по знакам конца предложения, иначе по паузе ≥0.7 с. */
export function sentencesFromWords(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ index: out.length + 1, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(" ").trim() });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const endsSentence = /[.!?…]$/.test(w.word);
    const next = words[i + 1];
    const longPause = next ? next.start - w.end >= 0.7 : false;
    if (endsSentence || (longPause && cur.length >= 4)) flush();
  }
  flush();
  return out;
}

const SYSTEM = `Ты сценарист и художник-постановщик короткого AI-фильма, который идёт в верхней половине вертикального ролика синхронно с речью автора. Автор говорит в нижней половине; фильм НЕ показывает автора и не повторяет его слова буквально — он показывает СМЫСЛ: историю, ситуацию, эмоцию, метафору. Фильм цельный: один визуальный стиль, один главный герой (если история про человека или от лица героя), узнаваемые места и предметы, действие развивается от эпизода к эпизоду.

Тебе дан текст речи как пронумерованные предложения с временем. Раздели речь на эпизоды по смыслу: каждый эпизод 5–10 секунд речи (минимум 4, максимум 12), одна сцена-действие, а не одно предложение. Для каждого эпизода — что происходит в кадре (английский, конкретное действие и обстановка, без текста и надписей в кадре, без логотипов), место, состояние героя и сцены после эпизода (чтобы следующий эпизод продолжался из него) и тип перехода к следующему: "continue" (та же сцена, действие продолжается), "match_cut" (та же история, другой ракурс/место, но узнаваемые детали), "new_sequence" (новая глава истории).

Story Bible: единый visualStyle (например "cinematic live-action, 35mm film look, natural light, muted warm palette" или "painterly 2D animation"), mainCharacter (если уместен: description, appearance — лицо, возраст, телосложение, причёска; clothes; signature — 1–3 узнаваемые детали, которые должны быть в каждом кадре с героем) либо null, locations, importantObjects, mood, cameraLanguage, storyArc, continuityRules (5–8 коротких правил на английском для художника: как выглядят герой, места, свет, что нельзя менять).

Правила:
- Никаких реальных известных людей по имени и внешности, никаких брендов, логотипов, текста в кадре, флагов, оружия крупным планом, детей в опасности.
- Не показывать говорящего человека крупным планом как диктора — фильм показывает историю.
- Если речь — рассуждение без сюжета, придумай сквозную визуальную метафору с героем и местом, которая проходит через все эпизоды.
- Ответь только JSON: {"bible": {...}, "episodes": [{"fromSentence": 1, "toSentence": 2, "meaning": "русский, 1 фраза", "visualAction": "english, 1–3 sentences", "location": "english", "stateAfter": "english", "transition": "continue|match_cut|new_sequence"}]}
- Эпизоды покрывают ВСЕ предложения по порядку без пропусков и пересечений.`;

type RawEpisode = {
  fromSentence: number;
  toSentence: number;
  meaning: string;
  visualAction: string;
  location: string;
  stateAfter: string;
  transition: string;
};

type RawStory = { bible: Partial<StoryBible>; episodes: RawEpisode[] };

function normalizeBible(b: Partial<StoryBible> | undefined): StoryBible {
  const s = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const mc = b?.mainCharacter && typeof b.mainCharacter === "object" ? b.mainCharacter : null;
  return {
    visualStyle: s(b?.visualStyle, "cinematic live-action, 35mm film look, natural light, muted warm palette"),
    mainCharacter: mc && s(mc.description)
      ? { description: s(mc.description), appearance: s(mc.appearance), clothes: s(mc.clothes), signature: s(mc.signature) }
      : null,
    locations: arr(b?.locations),
    importantObjects: arr(b?.importantObjects),
    mood: s(b?.mood, "calm, focused"),
    cameraLanguage: s(b?.cameraLanguage, "steady medium shots, slow push-ins, natural motion"),
    storyArc: s(b?.storyArc),
    continuityRules: arr(b?.continuityRules),
  };
}

/**
 * Эпизоды из ответа модели: границы по предложениям → секунды; пропуски и пересечения
 * чинятся (следующий эпизод начинается там, где закончился прошлый); слишком длинные
 * (>12 с) режутся по предложениям, слишком короткие (<3 с) сливаются с соседом.
 */
export function episodesFromRaw(raw: RawEpisode[], sentences: Sentence[]): FilmEpisode[] {
  if (!sentences.length) return [];
  const n = sentences.length;
  const clamp = (v: number) => Math.max(1, Math.min(n, Math.round(Number(v) || 1)));
  const items: { from: number; to: number; e: RawEpisode }[] = [];
  let cursor = 1;
  for (const e of raw ?? []) {
    let from = clamp(e.fromSentence);
    let to = clamp(e.toSentence);
    if (to < from) to = from;
    if (from > cursor) from = cursor; // пропуск — растягиваем назад
    if (from < cursor) from = cursor; // пересечение — сдвигаем вперёд
    if (from > n) break;
    if (to < from) to = from;
    items.push({ from, to, e });
    cursor = to + 1;
  }
  if (!items.length) items.push({ from: 1, to: n, e: { fromSentence: 1, toSentence: n, meaning: "", visualAction: "", location: "", stateAfter: "", transition: "continue" } });
  if (cursor <= n) items[items.length - 1].to = n; // хвост без эпизода — к последнему

  // длинные режем по предложениям на части ≤ 12 с
  const split: typeof items = [];
  for (const it of items) {
    const dur = sentences[it.to - 1].end - sentences[it.from - 1].start;
    if (dur <= 12 || it.to === it.from) { split.push(it); continue; }
    const parts = Math.ceil(dur / 10);
    const per = Math.max(1, Math.floor((it.to - it.from + 1) / parts));
    let from = it.from;
    while (from <= it.to) {
      const to = Math.min(it.to, from + per - 1);
      split.push({ from, to: split.length && to + per > it.to && to < it.to ? it.to : to, e: it.e });
      from = split[split.length - 1].to + 1;
    }
  }
  // короткие сливаем с предыдущим (или следующим для первого)
  const merged: typeof split = [];
  for (const it of split) {
    const dur = sentences[it.to - 1].end - sentences[it.from - 1].start;
    const prev = merged[merged.length - 1];
    if (dur < 3 && prev && prev.e === it.e) { prev.to = it.to; continue; }
    if (dur < 3 && prev && sentences[prev.to - 1].end - sentences[prev.from - 1].start < 8) { prev.to = it.to; continue; }
    merged.push({ ...it });
  }
  const tr = (v: string): FilmEpisode["transition"] => (v === "match_cut" || v === "new_sequence" ? v : "continue");
  return merged.map((it, i) => ({
    id: `E${i + 1}`,
    start: sentences[it.from - 1].start,
    end: sentences[it.to - 1].end,
    meaning: String(it.e.meaning ?? "").trim(),
    visualAction: String(it.e.visualAction ?? "").trim(),
    location: String(it.e.location ?? "").trim(),
    stateAfter: String(it.e.stateAfter ?? "").trim(),
    transition: tr(String(it.e.transition ?? "continue")),
  }));
}

export async function analyzeStory(args: {
  words: Word[];
  script: string;
  researchSummary?: string;
  topic?: string;
}): Promise<{ bible: StoryBible; episodes: FilmEpisode[]; sentences: Sentence[] }> {
  const sentences = sentencesFromWords(args.words);
  if (sentences.length < 2) throw new Error("AI-фильм: в речи меньше двух предложений — не из чего строить историю");
  const list = sentences.map((s) => `${s.index}. [${s.start.toFixed(1)}–${s.end.toFixed(1)} с] ${s.text}`).join("\n");
  const user =
    `${args.topic ? `Тема ролика: ${args.topic}\n` : ""}` +
    `${args.researchSummary ? `Справка по теме (факты, чтобы не выдумывать): ${args.researchSummary.slice(0, 1500)}\n\n` : ""}` +
    `Сценарий (что автор хотел сказать):\n${args.script.slice(0, 4000)}\n\n` +
    `Речь автора по предложениям (чистый таймлайн, всего ${sentences[sentences.length - 1].end.toFixed(1)} с):\n${list}`;
  // 16000, как у чистки речи и режиссёра: на 6000 разбор речи в 108 с упёрся в лимит с пустым текстом
  const raw = await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", system: SYSTEM, user });
  const parsed = parseJson<RawStory>(raw, "AI Film Story");
  const bible = normalizeBible(parsed.bible);
  const episodes = episodesFromRaw(parsed.episodes ?? [], sentences);
  if (!episodes.length) throw new Error("AI Film Story: модель не вернула эпизоды");
  return { bible, episodes, sentences };
}
