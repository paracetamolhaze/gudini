import { mediaComplete } from "./mediaLlm";
import { getSettings, ProjectMeta } from "./store";
import type { StoryResearchPack } from "./storyResearch";
import { addCost } from "./pipelineCost";

/** Блок сценария со ссылкой на факты, которые его подтверждают. */
export type ScriptBeat = { text: string; factIds: string[] };

// Opus — для сценариев (качество текста = лицо ролика); Sonnet — для утилитарных задач (в разы дешевле)
const MODEL_SCRIPT = "claude-opus-5";
const MODEL_UTIL = "claude-sonnet-5";

/**
 * Есть ли доступ к моделям. Сами запросы идут через общий транспорт
 * (lib/mediaLlm), поэтому попадают и в политику провайдеров, и в учёт денег —
 * своего клиента Anthropic здесь больше нет.
 */
function haveKey(): boolean {
  return Boolean(getSettings().anthropicKey);
}

// ===== Сценарий =====

/**
 * Модель не знает, какой сегодня день, и её память кончается раньше свежих событий:
 * сценарий про «Одиссею» Нолана обещал премьеру и трейлер через полтора месяца после
 * выхода фильма в прокат. Дата передаётся в каждый запрос явно.
 */
export function todayLine(now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `Сегодня ${d}. Всё, что датировано раньше этого дня, уже произошло.`;
}

/** Статус истории на сегодня из исследования — одной строкой для промпта. */
export function statusLine(research: Pick<StoryResearchPack, "status" | "statusNote" | "eventDate">): string {
  const label: Record<string, string> = {
    RELEASED: "уже вышел / состоялось",
    PAST: "уже произошло",
    ONGOING: "идёт сейчас",
    UPCOMING: "ещё не вышел / не состоялось",
  };
  const st = research.status && label[research.status] ? `${label[research.status]}` : "не установлен";
  return `Статус на сегодня: ${st}${research.statusNote ? ` — ${research.statusNote}` : ""}${research.eventDate ? ` (дата события ${research.eventDate})` : ""}.`;
}

const SCRIPT_SYSTEM = `Ты — сценарист вирусных вертикальных видео (TikTok, YouTube Shorts, Instagram Reels).
Пишешь сценарии, которые автор читает на камеру ОТ СВОЕГО ЛИЦА. Это его мнение и его голос,
а не сводка новостей и не пересказ чужих статей. Правила:
- Первое лицо и позиция: у автора есть отношение к теме, он его высказывает («я считаю»,
  «по-моему», «меня бесит», «мне нравится»), спорит, иронизирует, даёт оценку. Мнение подаётся
  как мнение, факт как факт; выдумывать цифры и события нельзя.
- Никаких названий изданий, «сообщает», «выпустил материал», «собрал список»: источники — не
  часть речи. Никаких списков статей и «кто что написал». Факты — своими словами, как их
  рассказал бы человек другу, не более 2–4 самых сильных на ролик.
- Точные даты и длинные числа только когда они и есть суть; иначе «вчера», «на этой неделе»,
  «почти сто тысяч».
- Если задан стиль автора — говори его словами и в его манере, соблюдай его запреты.
- Длительность чтения: 55–65 секунд (примерно 140–160 слов разговорной русской речи).
- Первые 3 секунды — мощный хук: интригующий вопрос, шокирующий факт или обещание пользы.
- Разговорный язык, короткие фразы, обращение на «ты», без канцелярита.
- Структура: хук → 3–4 содержательных пункта или история → вывод → призыв к действию (подписка/комментарий).
- Никаких ремарок, заголовков и пояснений — только чистый текст для чтения вслух.
- Тебе сообщают сегодняшнюю дату и статус темы. О том, что уже вышло или произошло, пиши в
  прошедшем времени; не обещай премьер, трейлеров и релизов, которые уже были. Не полагайся на
  свою память о датах и статусах — она может быть старее событий; верь дате и фактам из запроса.`;

const RESEARCH_SCRIPT_SYSTEM = `${SCRIPT_SYSTEM}

ВАЖНО: тебе дают результаты исследования — событие, дату, участников и проверенные факты со
ссылками. Это ОПОРА, а не текст для пересказа: выбери 2–4 самых сильных факта и вплети их в
позицию автора своими словами. Не добавляй существенных утверждений о реальности, которых нет
в пакете; мнения, оценки и реакции автора — можно и нужно. Имена, числа и даты бери из пакета
точно, но не цитируй издания и не перечисляй, кто что опубликовал.
Структура: хук с позицией автора → 2–4 мысли (тезис автора + факт + его комментарий) →
вывод-позиция → вопрос зрителю.

Ответь СТРОГО валидным JSON:
{"script":"полный текст для чтения вслух","beats":[{"text":"предложение из сценария","factIds":["id"]}]}
beats — разбивка сценария на смысловые блоки в том же порядке, что и в тексте; factIds — какие факты
подтверждают этот блок (пустой массив для хука, связки или призыва).`;

/** Сценарий из исследования: факты, участники и даты берутся из пакета, а не из памяти модели. */
/** Строка про автора для промпта: кто он и как говорит (из Настроек). */
export function authorLine(style?: string | null): string {
  const t = String(style ?? "").trim();
  return t ? `Автор и его манера (пиши от его лица, его словами, соблюдай его запреты): ${t.slice(0, 1200)}` : "";
}

export async function generateScriptFromResearch(
  research: StoryResearchPack,
): Promise<{ script: string; beats: ScriptBeat[]; demo: boolean } | null> {
  if (!haveKey()) return null;
  const author = authorLine(getSettings().authorStyle);
  const facts = research.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const entities = research.entities.map((e) => `${e.name} (${e.type})`).join(", ");
  const response = await mediaComplete({
    model: MODEL_SCRIPT,
    maxTokens: 16000,
    stage: "Script Generation",
    system: RESEARCH_SCRIPT_SYSTEM,
    user:
      `${todayLine()}\n${statusLine(research)}\n` +
      (author ? `${author}\n` : "") +
      `Событие: ${research.canonicalEvent}\n` +
      (research.eventDate ? `Дата: ${research.eventDate}\n` : "") +
      (research.location ? `Место: ${research.location}\n` : "") +
      `Участники: ${entities}\n\nПроверенные факты:\n${facts}\n\n` +
      `Краткое изложение: ${research.summary}`,
  });
  addCost({ scriptLlmCalls: 1 });
  const raw = response.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  try {
    const json = JSON.parse(raw);
    const script = String(json.script ?? "").trim();
    if (!script) return null;
    const known = new Set(research.facts.map((f) => f.id));
    const beats: ScriptBeat[] = (Array.isArray(json.beats) ? json.beats : [])
      .map((b: any) => ({
        text: String(b.text ?? "").trim(),
        factIds: (Array.isArray(b.factIds) ? b.factIds.map(String) : []).filter((id: string) => known.has(id)),
      }))
      .filter((b: ScriptBeat) => b.text.length > 3);
    return { script, beats, demo: false };
  } catch {
    return null;
  }
}

export async function generateScript(topic: string): Promise<{ script: string; demo: boolean }> {
  if (!haveKey()) return { script: demoScript(topic), demo: true };
  const author = authorLine(getSettings().authorStyle);
  const script = await mediaComplete({
    model: MODEL_SCRIPT,
    maxTokens: 16000,
    stage: "Script Generation",
    system: SCRIPT_SYSTEM,
    user: `${todayLine()}\n${author ? `${author}\n` : ""}Напиши сценарий видео на тему: «${topic}»`,
  });
  return { script, demo: false };
}

// ===== Описание и хэштеги =====

const META_SYSTEM = `Ты — SMM-редактор коротких вертикальных видео. По теме и сценарию видео составь метаданные для публикации.
Ответь СТРОГО валидным JSON без пояснений и без markdown-ограждений, в формате:
{"title": "цепляющий заголовок до 90 символов", "description": "описание 2–4 предложения с эмодзи и призывом", "hashtags": ["#тег1", "#тег2", ...]}
Хэштегов 8–12: смесь широких (#рек, #shorts) и тематических на русском и английском.`;

export async function generateMeta(topic: string, script: string): Promise<{ meta: ProjectMeta; demo: boolean }> {
  if (!haveKey()) return { meta: demoMeta(topic), demo: true };
  const raw = await mediaComplete({
    model: MODEL_UTIL,
    maxTokens: 16000,
    stage: "Metadata",
    system: META_SYSTEM,
    user: `${todayLine()}\nТема: ${topic}\n\nСценарий:\n${script}`,
  });
  try {
    const json = JSON.parse(raw.replace(/^```(json)?/m, "").replace(/```$/m, "").trim());
    return {
      meta: {
        title: String(json.title ?? topic),
        description: String(json.description ?? ""),
        hashtags: Array.isArray(json.hashtags) ? json.hashtags.map(String) : [],
      },
      demo: false,
    };
  } catch {
    return { meta: { title: topic, description: raw, hashtags: [] }, demo: false };
  }
}

// ===== План б-роллов (перебивок) =====

export type BrollPlan = { from: number; to: number; query: string };

const BROLL_SYSTEM = `Ты — монтажёр коротких вертикальных видео. Тебе дают слова речи с индексами.
Выбери 5–8 фраз (4–12 подряд идущих слов), которые стоит проиллюстрировать видеоперебивкой (б-роллом):
конкретные, визуализируемые вещи — места, животные, предметы, действия. Не выбирай абстракции и связки.
Фразы не должны пересекаться и не должны стоять в самом начале ролика (первые 2 слова — лицо автора).
Ответь СТРОГО валидным JSON-массивом без пояснений:
[{"from": индекс_первого_слова, "to": индекс_последнего_слова, "query": "запрос для видеостока на английском, 2-4 слова"}]`;

export async function planBrollSegments(
  words: { word: string }[],
  topic: string,
): Promise<BrollPlan[] | null> {
  if (!haveKey()) return null;
  const list = words.map((w, i) => `${i}:${w.word}`).join(" ");
  const response = await mediaComplete({
    model: MODEL_UTIL,
    maxTokens: 16000,
    stage: "Media Research",
    system: BROLL_SYSTEM,
    user: `Тема видео: ${topic}\n\nСлова:\n${list}`,
  });
  try {
    const raw = response.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
    const json = JSON.parse(raw);
    if (!Array.isArray(json)) return null;
    return json
      .map((s: any) => ({ from: Number(s.from), to: Number(s.to), query: String(s.query ?? "") }))
      .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from && s.query);
  } catch {
    return null;
  }
}

// ===== Демо-режим (без API-ключа) =====

function demoScript(topic: string): string {
  return `Ты точно об этом не знал! Сегодня разберём тему «${topic}» за одну минуту — досмотри до конца, там самое важное.

Первое. Большинство людей понимают «${topic}» неправильно, и из-за этого теряют время и деньги. Правда в том, что всё устроено проще, чем кажется.

Второе. Есть одно правило, которое меняет всё: начинай с малого, но начинай сегодня. Не жди идеального момента — его не будет.

Третье. Самая частая ошибка — слушать тех, кто сам ничего не сделал. Смотри на результаты, а не на слова.

И главный секрет: постоянство бьёт талант. Пятнадцать минут каждый день дадут больше, чем марафон раз в месяц.

Если было полезно — подпишись, дальше будет ещё интереснее. И напиши в комментариях, что думаешь про «${topic}» — читаю всё!`;
}

function demoMeta(topic: string): ProjectMeta {
  const tag = topic
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("");
  return {
    title: `${topic} — то, что тебе не рассказывали 🤯`,
    description: `Вся правда про «${topic}» за 60 секунд ⏱ Сохрани, чтобы не потерять, и подпишись — дальше больше 🔥`,
    hashtags: ["#рек", "#shorts", "#reels", "#рекомендации", "#полезное", "#лайфхак", `#${tag || "видео"}`, "#fyp", "#viral"],
  };
}
