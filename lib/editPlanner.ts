import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { Word } from "./transcribe";
import { EditPlan, RawPlanEvent, validatePlan, DEFAULT_CAPTION_STYLE } from "./editPlan";

const MODEL = "claude-sonnet-5";

const PLANNER_SYSTEM = `Ты — режиссёр монтажа коротких вертикальных видео (Reels/Shorts/TikTok).
Автор читал сценарий на камеру; тебе дают тему, оригинальный сценарий и реальную транскрипцию —
слова с индексами. Составь монтажный план, как сделал бы живой монтажёр в CapCut.

ЕДИНСТВЕННЫЙ тип события — B_ROLL: видеоперебивка поверх автора (голос продолжается).
Никаких приближений кадра, крупных надписей, титров и текстовых карточек — их в ролике нет вообще.

B_ROLL (границы — индексы слов from/to):
  query — ВИЗУАЛЬНЫЙ запрос для видеостока на английском (что должно быть в кадре, а не перевод фразы),
  alt — 2-3 альтернативных запроса,
  intent — {"subject":"главный объект (en)","action":"что происходит (en)","environment":"окружение (en)",
   "mood":"настроение (en)","mustHave":["обязательные условия, en"],"avoid":["недопустимое, en"]}

mustHave — ЖЁСТКИЙ фильтр: кандидат, где нет ХОТЯ БЫ ОДНОГО из этих условий, отбрасывается,
и перебивки не будет вовсе. Поэтому в mustHave обязательно клади:
  а) домен сюжета («football» для футбольной истории — иначе подойдёт скейтер вместо футболиста);
  б) ключевой объект сцены («stretcher», «advertising board»);
  в) место, если оно существенно («football pitch», «stadium» — «носилки на улице» это не то же самое,
     что «уносят с поля»).
avoid — конкретные подмены, которые выглядят похоже, но означают другое:
  для прыжка через рекламный щит: ["skateboard","skatepark","BMX","parkour","street trick","gym"];
  для носилок: ["street accident","hospital corridor","ambulance interior"].

sourceIntent для каждого B_ROLL:
- PERSON — назван конкретный человек. entity — имя латиницей ("Jordan Henderson").
  Ищем свободное фото именно его; не найдём — останется лицо автора, и это нормально.
- TEAM_MATCHUP — противостояние команд/стран. entity — "England vs Mexico".
- SPECIFIC_EVENT — конкретное событие. entity — его название.
- LOCATION — конкретное место.
- GENERIC_STOCK — обычный визуал (толпа болельщиков, рука в гипсе).

Правила режиссуры:
- Лицо автора ОСТАВЛЯТЬ на: хуке, эмоциях, личной истории, шутке, панчлайне, призыве. Хук (начало) не закрывать.
- Количество B_ROLL определяется содержанием: бывает 2, бывает 7. Не ставь перебивку ради перебивки.
- Не менять картинку каждые 1-2 секунды. Сдержанность: большинство склеек — hard cut.
- События не должны пересекаться. Между событиями — живые паузы с лицом автора.
- МИНИМАЛЬНОГО количества перебивок НЕТ. Если по-настоящему точных мест только три — пусть будет три.
  Десять секунд подряд с лицом автора лучше, чем одна неточная перебивка.
- Ставь B_ROLL только там, где ты уверен, что на стоке существует именно ЭТОТ кадр.
  Сомневаешься — не ставь событие вовсе.

Ответь СТРОГО валидным JSON без пояснений:
{"events":[
 {"type":"B_ROLL","from":12,"to":19,"sourceIntent":"PERSON","entity":"Jordan Henderson","query":"Jordan Henderson England football","alt":["..."],"intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["..."],"avoid":["..."]}},
 {"type":"B_ROLL","from":24,"to":30,"sourceIntent":"TEAM_MATCHUP","entity":"England vs Mexico","query":"England Mexico World Cup match","alt":["..."],"intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["football","England or Mexico national team"],"avoid":["empty stadium","training ground"]}}]}`;

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
  // смысловых жёлтых акцентов в субтитрах больше нет — только белый текст
  return { version: 1, duration, events, captionStyle: { ...DEFAULT_CAPTION_STYLE } };
}
