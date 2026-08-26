import fs from "fs";
import { getSettings } from "./store";

export type Word = { word: string; start: number; end: number };

/** Распознавание речи через OpenAI Whisper (пословные таймкоды). */
export async function whisperTranscribe(wavPath: string): Promise<Word[] | null> {
  const key = getSettings().openaiKey;
  if (!key) return null;
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(wavPath)], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", "ru");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper API: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  const words: Word[] = (json.words ?? []).map((w: any) => ({
    word: String(w.word).trim(),
    start: Number(w.start),
    end: Number(w.end),
  }));
  return words.length ? words : null;
}

/**
 * Резервный вариант без ключа OpenAI: раскладываем слова сценария по длительности
 * видео пропорционально длине слов (стример читает сценарий — совпадение достаточно близкое).
 */
export function alignScriptToDuration(script: string, durationSec: number): Word[] {
  const words = script
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ") // убрать ремарки в скобках
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return [];

  const lead = Math.min(0.4, durationSec * 0.02); // пауза перед первым словом
  const tail = Math.min(0.6, durationSec * 0.03);
  const usable = Math.max(1, durationSec - lead - tail);

  // вес слова = длина + константа (учитывает паузы между словами)
  const weights = words.map((w) => w.length + 3);
  const total = weights.reduce((a, b) => a + b, 0);

  const result: Word[] = [];
  let t = lead;
  for (let i = 0; i < words.length; i++) {
    const dur = (weights[i] / total) * usable;
    result.push({ word: words[i], start: t, end: t + dur });
    t += dur;
  }
  return result;
}
