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

factualSpecificity — насколько конкретен нужный кадр. От него зависит вся стратегия поиска:
- EXACT — именно ЭТО событие с этим человеком («Хендерсон перепрыгивает рекламный щит»,
  «Хендерсона уносят на носилках»). Сначала ищем реальный кадр события в открытых источниках.
  Подмена похожим ЗАПРЕЩЕНА: не нашли — остаётся лицо автора.
- ENTITY — конкретный человек/команда в любой ситуации («Хендерсон на скамейке», «сборная Англии»).
- GENERAL — общая иллюстрация («болельщики празднуют»), тут допустим обычный сток.

queries — 4–8 РАЗНЫХ поисковых формулировок на английском для фактического поиска, от самой
конкретной к более общей. Для действий ищется ВИДЕО, поэтому формулируй как описание кадра. Для EXACT/ENTITY обязательно включай имя и контекст события:
["Jordan Henderson advertising board injury","Jordan Henderson jumps hoarding celebration",
 "Henderson World Cup injury barrier","England Mexico Henderson injury"].
Не пиши «football stadium» — это не поиск факта.
event — короткое описание события на английском для EXACT.

sourceIntent для каждого B_ROLL:
- PERSON — назван конкретный человек. entity — имя латиницей ("Jordan Henderson").
  Ищем свободное фото именно его; не найдём — останется лицо автора, и это нормально.
- TEAM_MATCHUP — противостояние команд/стран. entity — "England vs Mexico".
- SPECIFIC_EVENT — конкретное событие. entity — его название.
- LOCATION — конкретное место.
- GENERIC_STOCK — обычный визуал (толпа болельщиков, рука в гипсе).

Правила режиссуры:
- Лицо автора ОСТАВЛЯТЬ на: эмоциях, личной истории, шутке, панчлайне, призыве.
  Открытая фраза (первые ~2 сек) — лицо автора, но ДАЛЬШЕ хук закрывать визуалом НУЖНО:
  это самая важная часть ролика, и 8 секунд одного лица в начале убивают удержание.
- ЕСЛИ В СЦЕНАРИИ ВПЕРВЫЕ НАЗЫВАЮТ ЧЕЛОВЕКА — обязательно поставь PERSON-вставку на 1.5–2.5 сек
  именно в этот момент: зритель должен увидеть, о ком речь. Это не опция.
- Количество B_ROLL определяется содержанием: бывает 2, бывает 7. Не ставь перебивку ради перебивки.
- ГОЛОС — непрерывная основа, ВИДЕО — постоянно меняющийся слой. На ~60 секунд ориентир
  8–14 вставок, каждая 1.8–4.0 сек (до 5 только для по-настоящему сильного кадра).
  Визуальное состояние должно меняться примерно каждые 2.5–4.5 секунды.
- Разбей сценарий на смысловые блоки и ищи визуал почти для КАЖДОГО. Не оставляй 8–12 секунд
  подряд на лице автора там, где смысл можно показать.
- Один блок можно закрыть ДВУМЯ короткими вставками подряд (например 2.5 сек человек +
  2.5 сек контекст события) — это лучше, чем один клип на 6 секунд.
- Если точного кадра события нет, разрешена ЦЕПОЧКА честных кадров: человек → рекламные щиты
  у кромки поля → падение/травма. Каждый кадр обязан быть честно связан со смыслом.
- Но квоты нет: неточная вставка всё равно хуже лица автора. Не ставь событие, если не веришь,
  что подходящий кадр существует.
- Ищи визуал под СМЫСЛ ВСЕЙ ФРАЗЫ, а не под одно слово: не «щит», а «футболист перепрыгивает
  рекламный щит у кромки поля».
- События не должны пересекаться. Переход всегда один — hard cut, никаких эффектов.

Ответь СТРОГО валидным JSON без пояснений:
{"events":[
 {"type":"B_ROLL","from":12,"to":19,"sourceIntent":"PERSON","factualSpecificity":"ENTITY","entity":"Jordan Henderson","query":"Jordan Henderson England football","queries":["Jordan Henderson England national team","Jordan Henderson footballer portrait","Jordan Henderson World Cup"],"intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["..."],"avoid":["..."]}},
 {"type":"B_ROLL","from":33,"to":38,"sourceIntent":"SPECIFIC_EVENT","factualSpecificity":"EXACT","entity":"Jordan Henderson","event":"jump over advertising board after match","query":"Jordan Henderson advertising board injury","queries":["Jordan Henderson advertising hoarding injury","Henderson celebration barrier injury","England Mexico Henderson injury"],"intent":{"subject":"...","action":"...","environment":"...","mood":"...","mustHave":["football","advertising board","stadium pitch"],"avoid":["skateboard","BMX","parkour","random athlete"]}}]}`;

/**
 * Второй проход: заполняет длинные участки, где виден только автор.
 * Первый проход ищет точные кадры события; этот добирает визуалы попроще —
 * фотографии людей и команд, честный контекст, релевантный сток.
 */
export async function planGapFillers(
  topic: string,
  script: string | null,
  words: Word[],
  duration: number,
  gaps: { start: number; end: number }[],
): Promise<RawPlanEvent[]> {
  const key = getSettings().anthropicKey;
  if (!key || !gaps.length) return [];
  const client = new Anthropic({ apiKey: key });
  const list = words.map((w, i) => `${i}:${w.word}[${w.start.toFixed(1)}]`).join(" ");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system:
      PLANNER_SYSTEM +
      `\n\nСЕЙЧАС ВТОРОЙ ПРОХОД. В ролике слишком долго видно только лицо автора. Тебе дают участки, ` +
      `которые нужно закрыть визуалом. Правила смягчены: ФОТОГРАФИЯ — полноценный источник. ` +
      `Если точного видео события нет, бери фото человека, фото команды, честный контекст ` +
      `(рекламные щиты у поля, скамейка запасных, врачи на поле) или релевантный сток. ` +
      `Подмена события чужим сюжетом по-прежнему запрещена. Один участок можно закрыть ДВУМЯ ` +
      `короткими вставками по 1.5–3 сек. Верни ТОЛЬКО новые события внутри указанных участков.`,
    messages: [
      {
        role: "user",
        content:
          `Тема: ${topic}\n\n` +
          (script ? `Сценарий:\n${script}\n\n` : "") +
          `Транскрипция (индекс:слово[секунда]):\n${list}\n\n` +
          `Закрыть визуалом участки (сек): ${gaps.map((g) => `${g.start.toFixed(1)}–${g.end.toFixed(1)}`).join(", ")}`,
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
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

/** Строит валидированный монтажный план. Возвращает null, если ИИ недоступен/упал. */
export async function planEdit(
  topic: string,
  script: string | null,
  words: Word[],
  duration: number,
  /** моменты видимых склеек после чистки речи — их желательно накрыть перебивкой */
  seamPoints: number[] = [],
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
          `Транскрипция (индекс:слово), длительность ${duration.toFixed(1)} сек:\n${list}` +
          (seamPoints.length
            ? `\n\nСКЛЕЙКИ РЕЧИ на ${seamPoints.map((s) => s.toFixed(1)).join(", ")} сек. ` +
              `В этих местах вырезаны запинки, и лицо автора заметно «прыгает». ` +
              `Постарайся поставить перебивку так, чтобы она НАЧИНАЛАСЬ примерно за 0.3 сек до склейки ` +
              `и заканчивалась после неё — тогда монтаж речи не будет виден.`
            : ""),
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
