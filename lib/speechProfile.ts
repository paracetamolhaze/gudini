import fs from "fs";
import path from "path";

/**
 * Профиль подачи автора: темп, длина фраз, паузы, высота голоса. Считается скриптом
 * scripts/voice-profile.ts по его публичным роликам и лежит в data/speech-profile.json.
 * Используется телесуфлёром (скорость текста по умолчанию) и сценаристом (ритм фраз).
 */
export type SpeechProfile = {
  source?: string;
  createdAt?: string;
  wordsPerMinute: number;
  sentenceWords?: { median: number; p90: number };
  pauseBetweenWordsSec?: { median: number; p90: number };
  longPauses?: { perMinute: number; medianSec: number };
  fillersPerMinute?: number;
  pitchHz?: { median: number; low: number; high: number };
};

const FILE = path.join(process.cwd(), "data", "speech-profile.json");

export function readSpeechProfile(): SpeechProfile | null {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return j && Number.isFinite(Number(j.wordsPerMinute)) && j.wordsPerMinute > 0 ? (j as SpeechProfile) : null;
  } catch {
    return null;
  }
}

/** Строка для промпта сценария: ритм автора, чтобы текст ложился на его речь. */
export function rhythmLine(p: SpeechProfile | null): string {
  if (!p) return "";
  const wpm = Math.round(p.wordsPerMinute);
  const words60 = Math.round(wpm);
  const sent = p.sentenceWords?.median ? ` Фразы автора в среднем ${p.sentenceWords.median} слов, не длиннее ${p.sentenceWords.p90 || p.sentenceWords.median * 2}: держи такой ритм.` : "";
  return `Темп речи автора ${wpm} слов в минуту: на 60 секунд ${words60} слов, на 55–65 секунд ${Math.round(words60 * 0.92)}–${Math.round(words60 * 1.08)}.${sent}`;
}
