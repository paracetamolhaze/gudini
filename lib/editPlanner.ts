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
  плюс alt — 2-3 альтернативных запроса, плюс intent — структурное описание нужного кадра:
  {"subject":"главный объект (en)","action":"что происходит (en)","environment":"окружение (en)",
   "mood":"настроение (en)","mustHave":["без чего кадр не подходит, en"],"avoid":["что недопустимо, en:
   zoo cage/cartoon/логотипы и т.п."]}
- PUNCH_IN — лёгкое приближение кадра автора на сильной фразе, scale 1.04–1.08, не чаще чем раз в ~10 секунд.
- TEXT_CALLOUT — крупный текст поверх: важная цифра, цена, дата, имя ("500 000 ЧЕЛОВЕК", "$5,000").
  ЗАПРЕЩЕНО дублировать то, что человек произносит в этот момент: субтитры это уже показывают.
  Каллаут нужен, только если добавляет то, чего в речи нет в таком виде (сумма цифрами, год, счёт).

ГЛАВНОЕ ПРО B_ROLL — sourceIntent. Общий сток по теме («просто футбольное поле», когда речь про
конкретный матч) — плохая перебивка. Для каждого B_ROLL укажи sourceIntent:
- PERSON — назван конкретный человек. entity — его имя латиницей ("Jordan Henderson").
  Мы ищем свободное фото этого человека; если не найдём — оставим лицо автора, и это нормально.
- TEAM_MATCHUP — противостояние команд/стран. entity — "England vs Mexico",
  graphic — строки нашей графики: ["АНГЛИЯ","VS","МЕКСИКА"].
- SPECIFIC_EVENT — конкретное событие (матч, церемония). entity — его название.
- LOCATION — конкретное место.
- GRAPHIC — визуализируется только текстом: graphic — 1–3 КОРОТКИЕ строки ("1/8 ФИНАЛА",
  "ЖЁЛТАЯ КАРТОЧКА"). query можно не давать. Строки НЕ должны повторять субтитры дословно.
- GENERIC_STOCK — обычный визуал (толпа болельщиков, носилки, руки в гипсе) — тогда всё как раньше.
Если сущность конкретная, а подходящего материала может не быть — лучше GRAPHIC или вообще
не ставить перебивку. Лицо автора лучше случайного кадра «по теме».

Правила режиссуры:
- Лицо автора ОСТАВЛЯТЬ на: хуке, эмоциях, личной истории, шутке, панчлайне, призыве. Хук (начало) не закрывать.
- Количество B_ROLL определяется содержанием: бывает 2, бывает 7. Не ставь перебивку ради перебивки.
- Не менять картинку каждые 1-2 секунды. Сдержанность: большинство склеек — hard cut.
- События не должны пересекаться. Между событиями — живые паузы с лицом автора.
- Для цифр и цен предпочитай TEXT_CALLOUT, а не случайный сток.

Ответь СТРОГО валидным JSON без пояснений:
{"events":[
 {"type":"B_ROLL","from":12,"to":19,"sourceIntent":"PERSON","entity":"Jordan Henderson","query":"Jordan Henderson England football","alt":["..."],"intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["..."],"avoid":["..."]}},
 {"type":"B_ROLL","from":24,"to":30,"sourceIntent":"TEAM_MATCHUP","entity":"England vs Mexico","graphic":["АНГЛИЯ","VS","МЕКСИКА"],"query":"England Mexico football match","intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["..."],"avoid":["..."]}},
 {"type":"PUNCH_IN","from":30,"to":36,"scale":1.06},
 {"type":"TEXT_CALLOUT","from":44,"to":47,"text":"..."}]}`;

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
