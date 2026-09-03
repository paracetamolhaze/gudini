import { mediaComplete } from "./mediaLlm";
import { getSettings } from "./store";
import { Word } from "./transcribe";
import { SilenceEvent } from "./ffmpeg";
import { RawCleanupAction } from "./speechCleanupPlan";

const MODEL = "claude-sonnet-5";

const CLEANUP_SYSTEM = `Ты — монтажёр, который чистит речь автора короткого видео. Автор читал сценарий на камеру;
тебе дают ОРИГИНАЛЬНЫЙ сценарий, реальную транскрипцию (слова с индексами и таймкодами) и список пауз.

Найди ТОЛЬКО очевидный мусор, которого нет в сценарии:
- FILLER: «ээ», «эм», «ммм», и слова-паразиты («ну», «как бы», «типа», «короче») — ТОЛЬКО если их нет
  в этом месте оригинального сценария;
- REPEATED_WORDS: подряд повторённое слово/пара слов («я я хотел», «это это был») — вырезается лишний повтор;
- FALSE_START: оборванный кусок фразы, после которого автор перезапустил мысль заново (сверяй со сценарием,
  вырезается неудачный заход, остаётся полный);
- SELF_CORRECTION: ошибка + маркер («ой», «нет», «точнее») + исправление — вырезается ошибочная часть
  и маркер, остаётся исправленная;
- RETAKE: НЕУДАЧНЫЙ ДУБЛЬ. Автор сбился и переснял мысль целиком: рядом стоят ДВА фрагмента,
  которые соответствуют ОДНОМУ И ТОМУ ЖЕ предложению сценария. Вырезается неудачная попытка,
  остаётся полная и чистая. Так бывает на 3–20 словах — это нормальная длина для RETAKE.

Как искать RETAKE: возьми предложение сценария и найди в транскрипции все места, где автор его читает.
Если таких мест рядом два — сравни их: покрытие предложения, оборванность, запинки, повторы,
законченность. Оставь лучшую попытку, а худшую отметь RETAKE (fromWord/toWord — границы худшей).
НЕ отмечай RETAKE, если автор осознанно повторяет мысль позже для усиления, если фрагменты далеко
друг от друга по времени или если они относятся к РАЗНЫМ предложениям сценария. confidence ≥0.85.

Обрыв слова с «--» («эк--», «под--») и протянутое «э-э-э» — всегда мусор (FILLER).
Если после фальстарта автор начал ту же фразу заново с того же союза («…щит и | неудачно падает с под-- |
и спотыкается…»), союз перед фальстартом входит в вырезку — иначе останется «и … и».

Каждую паузу из списка классифицируй: INTENTIONAL (драматическая, смысловая, перед панчлайном — оставить)
или UNNECESSARY (вдох, провал, потеря мысли, зазор между словами одной мысли — ужать). Пауза между
предложениями короче 0.6 с — нормальный ритм; длиннее — UNNECESSARY, если это не намеренная выдержка.
В списке пауз есть и тишина по детектору, и зазоры между словами расшифровки.

ЖЁСТКИЕ ПРАВИЛА БЕЗОПАСНОСТИ:
- если сомневаешься — НЕ включай действие в план; лучше вырезать меньше, чем сломать речь;
- не вырезай полноценные смысловые куски, даже если их нет в сценарии (импровизация — это нормально);
- не трогай первые секунды (хук);
- confidence ставь честно: 0.9+ только для стопроцентного мусора.

Ответь СТРОГО валидным JSON без пояснений:
{"actions":[
 {"type":"REMOVE_FRAGMENT","fromWord":12,"toWord":13,"reason":"REPEATED_WORDS","confidence":0.9},
 {"type":"REMOVE_FRAGMENT","fromWord":88,"toWord":103,"reason":"RETAKE","confidence":0.9},
 {"type":"SHORTEN_PAUSE","silenceIndex":2,"verdict":"UNNECESSARY","confidence":0.85},
 {"type":"SHORTEN_PAUSE","silenceIndex":4,"verdict":"INTENTIONAL","confidence":0.9}
]}`;

/** Запрашивает у Claude план чистки речи. null — если ИИ недоступен или ответ не разобрался. */
export async function planSpeechCleanup(
  script: string | null,
  words: Word[],
  silences: SilenceEvent[],
): Promise<RawCleanupAction[] | null> {
  const key = getSettings().anthropicKey;
  if (!key || words.length < 8) return null;

  const wordList = words.map((w, i) => `${i}:${w.word}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(" ");
  const silenceList = silences
    .map((s, i) => `S${i}: ${s.start.toFixed(2)}-${s.end.toFixed(2)} (${(s.end - s.start).toFixed(1)}с)`)
    .join("\n");

  const raw = (
    await mediaComplete({
      system: CLEANUP_SYSTEM,
      // Модель отвечает длинно (на 200 слов речи — до 6000 токенов): при лимите
      // 6000 ответ обрезался, JSON не разбирался, и план сводился к одним обрывам.
      // Лимит прежний; оценка бюджета по нему пессимистична — это осознанно.
      maxTokens: 16000,
      stage: "Speech Cleanup",
      user:
        (script ? `Оригинальный сценарий:\n${script}\n\n` : "Оригинального сценария нет.\n\n") +
        `Транскрипция:\n${wordList}\n\nПаузы:\n${silenceList || "(нет)"}`,
    })
  )
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();
  const actions = parseCleanupResponse(raw);
  if (!actions) console.warn(`Speech Cleanup: ответ модели не разобран (${raw.length} символов): ${raw.slice(0, 400)}`);
  return actions;
}

/**
 * Разбор ответа: сначала как целый JSON; если он обрезан или обёрнут в текст —
 * действия вытаскиваются по одному объекту. Обрезанный ответ раньше означал
 * «плана нет», и ролик уходил с невырезанными дублями.
 */
export function parseCleanupResponse(raw: string): RawCleanupAction[] | null {
  const text = raw.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json?.actions)) return json.actions;
  } catch {}
  const salvaged: RawCleanupAction[] = [];
  for (const m of text.matchAll(/\{[^{}]*"type"\s*:\s*"(REMOVE_FRAGMENT|SHORTEN_PAUSE)"[^{}]*\}/g)) {
    try {
      salvaged.push(JSON.parse(m[0]));
    } catch {}
  }
  return salvaged.length ? salvaged : null;
}
