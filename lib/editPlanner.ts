import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { Word } from "./transcribe";
import { EditPlan, RawPlanEvent, validatePlan, DEFAULT_CAPTION_STYLE } from "./editPlan";

const MODEL = "claude-sonnet-5";

const PLANNER_SYSTEM = `Ты — режиссёр монтажа коротких вертикальных видео (Reels/Shorts/TikTok).
Автор читал сценарий на камеру; тебе дают тему, оригинальный сценарий и реальную транскрипцию —
слова с индексами. Составь монтажный план, как сделал бы живой монтажёр в CapCut.

Типы событий (границы — индексы слов from/to):
- B_ROLL — видеоперебивка поверх автора (голос продолжается). Только для КОНКРЕТНОГО визуализируемого:
  место, предмет, животное, действие, событие. query — ВИЗУАЛЬНЫЙ запрос для видеостока на английском
  (не буквальный перевод фразы, а что должно быть в кадре: "young man packing suitcase cinematic"),
  плюс alt — 2-3 альтернативных запроса.
- PUNCH_IN — лёгкое приближение кадра автора на сильной фразе, scale 1.04–1.08.
- TEXT_CALLOUT — крупный текст поверх: важная цифра, цена, дата, имя ("500 000 ЧЕЛОВЕК", "$5,000").

Правила режиссуры:
- Лицо автора ОСТАВЛЯТЬ на: хуке, эмоциях, личной истории, шутке, панчлайне, призыве. Хук (начало) не закрывать.
- Количество B_ROLL определяется содержанием: бывает 2, бывает 7. Не ставь перебивку ради перебивки.
- Не менять картинку каждые 1-2 секунды. Сдержанность: большинство склеек — hard cut.
- События не должны пересекаться. Между событиями — живые паузы с лицом автора.
- Для цифр и цен предпочитай TEXT_CALLOUT, а не случайный сток.

Ответь СТРОГО валидным JSON без пояснений:
{"events":[{"type":"B_ROLL","from":12,"to":19,"query":"...","alt":["...","..."]},{"type":"PUNCH_IN","from":30,"to":36,"scale":1.06},{"type":"TEXT_CALLOUT","from":44,"to":47,"text":"..."}]}`;

/** Строит валидированный монтажный план. Возвращает null, если ИИ недоступен/упал. */
export async function planEdit(
  topic: string,
  script: string | null,
  words: Word[],
  duration: number,
): Promise<EditPlan | null> {
  const key = getSettings().anthropicKey;
  if (!key || words.length < 10) return null;

  const client = new Anthropic({ apiKey: key });
  const list = words.map((w, i) => `${i}:${w.word}`).join(" ");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: PLANNER_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Тема: ${topic}\n\n` +
          (script ? `Оригинальный сценарий:\n${script}\n\n` : "") +
          `Транскрипция (индекс:слово), длительность ${duration.toFixed(1)} сек:\n${list}`,
      },
    ],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();

  let parsed: { events?: RawPlanEvent[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const events = validatePlan(parsed.events ?? [], words, duration);
  return { version: 1, duration, events, captionStyle: { ...DEFAULT_CAPTION_STYLE } };
}
