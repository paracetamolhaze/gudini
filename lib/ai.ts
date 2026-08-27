import Anthropic from "@anthropic-ai/sdk";
import { getSettings, ProjectMeta } from "./store";
import type { StoryResearchPack } from "./storyResearch";
import { addCost } from "./pipelineCost";

/** Блок сценария со ссылкой на факты, которые его подтверждают. */
export type ScriptBeat = { text: string; factIds: string[] };

// Opus — для сценариев (качество текста = лицо ролика); Sonnet — для утилитарных задач (в разы дешевле)
const MODEL_SCRIPT = "claude-opus-5";
const MODEL_UTIL = "claude-sonnet-5";

function client(): Anthropic | null {
  const key = getSettings().anthropicKey;
  return key ? new Anthropic({ apiKey: key }) : null;
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ===== Сценарий =====

const SCRIPT_SYSTEM = `Ты — сценарист вирусных вертикальных видео (TikTok, YouTube Shorts, Instagram Reels).
Пишешь сценарии, которые автор читает на камеру. Правила:
- Длительность чтения: 55–65 секунд (примерно 140–160 слов разговорной русской речи).
- Первые 3 секунды — мощный хук: интригующий вопрос, шокирующий факт или обещание пользы.
- Разговорный язык, короткие фразы, обращение на «ты», без канцелярита.
- Структура: хук → 3–4 содержательных пункта или история → вывод → призыв к действию (подписка/комментарий).
- Никаких ремарок, заголовков и пояснений — только чистый текст для чтения вслух.`;

const RESEARCH_SCRIPT_SYSTEM = `${SCRIPT_SYSTEM}

ВАЖНО: тебе дают результаты исследования истории — событие, дату, участников и проверенные факты
со ссылками. Пиши сценарий ТОЛЬКО по ним. Не добавляй существенных утверждений, которых нет в фактах:
если детали не было в исследовании, её не должно быть в тексте. Имена, числа, даты и названия
организаций бери из пакета дословно.

Ответь СТРОГО валидным JSON:
{"script":"полный текст для чтения вслух","beats":[{"text":"предложение из сценария","factIds":["id"]}]}
beats — разбивка сценария на смысловые блоки в том же порядке, что и в тексте; factIds — какие факты
подтверждают этот блок (пустой массив для хука, связки или призыва).`;

/** Сценарий из исследования: факты, участники и даты берутся из пакета, а не из памяти модели. */
export async function generateScriptFromResearch(
  research: StoryResearchPack,
): Promise<{ script: string; beats: ScriptBeat[]; demo: boolean } | null> {
  const c = client();
  if (!c) return null;
  const facts = research.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const entities = research.entities.map((e) => `${e.name} (${e.type})`).join(", ");
  const response = await c.messages.create({
    model: MODEL_SCRIPT,
    max_tokens: 16000,
    system: RESEARCH_SCRIPT_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Событие: ${research.canonicalEvent}\n` +
          (research.eventDate ? `Дата: ${research.eventDate}\n` : "") +
          (research.location ? `Место: ${research.location}\n` : "") +
          `Участники: ${entities}\n\nПроверенные факты:\n${facts}\n\n` +
          `Краткое изложение: ${research.summary}`,
      },
    ],
  });
  addCost({ scriptLlmCalls: 1 });
  const raw = textOf(response).replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
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
  const c = client();
  if (!c) return { script: demoScript(topic), demo: true };
  const response = await c.messages.create({
    model: MODEL_SCRIPT,
    max_tokens: 16000,
    system: SCRIPT_SYSTEM,
    messages: [{ role: "user", content: `Напиши сценарий видео на тему: «${topic}»` }],
  });
  return { script: textOf(response), demo: false };
}

// ===== Описание и хэштеги =====

const META_SYSTEM = `Ты — SMM-редактор коротких вертикальных видео. По теме и сценарию видео составь метаданные для публикации.
Ответь СТРОГО валидным JSON без пояснений и без markdown-ограждений, в формате:
{"title": "цепляющий заголовок до 90 символов", "description": "описание 2–4 предложения с эмодзи и призывом", "hashtags": ["#тег1", "#тег2", ...]}
Хэштегов 8–12: смесь широких (#рек, #shorts) и тематических на русском и английском.`;

export async function generateMeta(topic: string, script: string): Promise<{ meta: ProjectMeta; demo: boolean }> {
  const c = client();
  if (!c) return { meta: demoMeta(topic), demo: true };
  const response = await c.messages.create({
    model: MODEL_UTIL,
    max_tokens: 16000,
    system: META_SYSTEM,
    messages: [{ role: "user", content: `Тема: ${topic}\n\nСценарий:\n${script}` }],
  });
  const raw = textOf(response);
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
  const c = client();
  if (!c) return null;
  const list = words.map((w, i) => `${i}:${w.word}`).join(" ");
  const response = await c.messages.create({
    model: MODEL_UTIL,
    max_tokens: 16000,
    system: BROLL_SYSTEM,
    messages: [{ role: "user", content: `Тема видео: ${topic}\n\nСлова:\n${list}` }],
  });
  try {
    const raw = textOf(response).replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
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
