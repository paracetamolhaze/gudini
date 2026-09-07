/**
 * Бесплатные «ворота» перед платными стадиями монтажа.
 *
 * Случай, ради которого они появились: запись с телесуфлёра на iPhone пришла
 * с уровнем речи −57 дБ (камера телефона даёт −29 дБ), после 32-й секунды —
 * шум на −73 дБ. Распознавание нашло 52 слова из 157 в сценарии, а конвейер
 * заметил это только в режиссёре монтажа — после исследования, медиатеки и
 * визуальной проверки на $1.19. Теперь такая запись останавливается сразу после
 * анализа звука (уровень) и после распознавания (покрытие сценария), ничего не потратив.
 *
 * Отключение: SPEECH_GATE=off. Пороги: SPEECH_MIN_LEVEL_DB, TRANSCRIPT_MIN_SCRIPT_RATIO.
 */

export type LevelReport = {
  /** 90-й перцентиль посекундного RMS, дБFS: уровень речи без влияния щелчков. */
  loudestDb: number;
  /** Секунды, где RMS выше −40 дБ (для обычной записи — вся речь). */
  activeSeconds: number;
  /** Последняя секунда с активным звуком. */
  lastActiveAt: number;
  windowSec: number;
};

export const SPEECH_LEVEL_LIMIT_DB = -45;
/** Ниже этого уровня анализ (тишины, распознавание) идёт по усиленной копии звука. */
export const SPEECH_LEVEL_BOOST_BELOW_DB = -30;
export const SPEECH_LEVEL_TARGET_DB = -25;
export const TRANSCRIPT_MIN_WORDS = 10;
export const TRANSCRIPT_MIN_SCRIPT_RATIO = 0.4;
const ACTIVE_DB = -40;

export function speechGateEnabled(): boolean {
  return process.env.SPEECH_GATE !== "off";
}

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function analyzeLevel(windowsDb: number[], windowSec = 1): LevelReport {
  const clean = windowsDb.filter((v) => Number.isFinite(v));
  if (!clean.length) return { loudestDb: -100, activeSeconds: 0, lastActiveAt: 0, windowSec };
  const sorted = [...clean].sort((a, b) => a - b);
  const loudestDb = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  let activeSeconds = 0;
  let lastActiveAt = 0;
  clean.forEach((v, i) => {
    if (v > ACTIVE_DB) {
      activeSeconds += windowSec;
      lastActiveAt = (i + 1) * windowSec;
    }
  });
  return { loudestDb, activeSeconds, lastActiveAt, windowSec };
}

/** Ошибка, если запись почти беззвучная; иначе null. */
export function levelGateError(level: LevelReport): string | null {
  if (!speechGateEnabled()) return null;
  const limit = envNumber("SPEECH_MIN_LEVEL_DB", SPEECH_LEVEL_LIMIT_DB);
  if (level.loudestDb >= limit) return null;
  return (
    `Запись почти беззвучная: уровень речи ${level.loudestDb.toFixed(0)} дБ при норме −20…−30 дБ ` +
    `(запись с камеры телефона даёт около −29 дБ). Микрофон в браузере писал слишком тихо — ` +
    `перезапишите дубль, глядя на индикатор микрофона, или загрузите файл с камеры. Платные стадии не запускались.`
  );
}

/** Усиление (дБ) для копии звука под анализ: 0 — не нужно. */
export function analysisGainDb(level: LevelReport): number {
  const below = envNumber("SPEECH_BOOST_BELOW_DB", SPEECH_LEVEL_BOOST_BELOW_DB);
  if (level.loudestDb >= below) return 0;
  return Math.min(30, Math.max(0, Math.round(SPEECH_LEVEL_TARGET_DB - level.loudestDb)));
}

export function countScriptWords(script: string | undefined | null): number {
  return (script ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Ошибка, если распознанной речи слишком мало для монтажа по сценарию; иначе null. */
export function transcriptGateError(
  words: { start: number; end: number }[],
  duration: number,
  script: string | undefined | null,
): string | null {
  if (!speechGateEnabled()) return null;
  const n = words.length;
  const lastEnd = words.reduce((m, w) => Math.max(m, w.end), 0);
  const where = `речь слышна до ${lastEnd.toFixed(1)} с из ${duration.toFixed(0)} с записи`;
  if (n < TRANSCRIPT_MIN_WORDS) {
    return `Распознано только ${n} слов (${where}). В записи нет читаемой речи — проверьте микрофон и перезапишите дубль. Распознавание речи уже оплачено; исследование, медиатека и режиссёр не запускались.`;
  }
  const scriptWords = countScriptWords(script);
  const ratio = envNumber("TRANSCRIPT_MIN_SCRIPT_RATIO", TRANSCRIPT_MIN_SCRIPT_RATIO);
  if (scriptWords >= 40 && n < scriptWords * ratio) {
    const pct = Math.round((100 * n) / scriptWords);
    return (
      `Распознано ${n} слов из ~${scriptWords} в сценарии (${pct}%): ${where}. ` +
      `Дальше звук слишком тихий или его нет — перезапишите дубль или загрузите файл с камеры. ` +
      `Распознавание речи уже оплачено; исследование, медиатека и режиссёр не запускались (порог TRANSCRIPT_MIN_SCRIPT_RATIO=${ratio}).`
    );
  }
  return null;
}
