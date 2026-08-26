import Anthropic from "@anthropic-ai/sdk";
import { getSettings, ProjectMeta } from "./store";

const MODEL = "claude-opus-5";

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

export async function generateScript(topic: string): Promise<{ script: string; demo: boolean }> {
  const c = client();
  if (!c) return { script: demoScript(topic), demo: true };
  const response = await c.messages.create({
    model: MODEL,
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
    model: MODEL,
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
