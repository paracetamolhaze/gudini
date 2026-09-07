// Профиль подачи стримера по публичным reels: темп, паузы, фразы, громкость, высота голоса.
// Запускается внутри воркера (там ключ ElevenLabs и lib/transcribe). Ничего не публикует.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { scribeTranscribe, type Word } from "../lib/transcribe";

const DIR = process.env.VOICE_PROFILE_DIR || "/app/data/voice-profile";
const FILLERS = ["ну", "типа", "короче", "вот", "как бы", "э", "эм", "значит", "в общем", "слушайте", "смотрите"];

function wav(src: string): string {
  const out = src.replace(/\.mp4$/, ".wav");
  if (!fs.existsSync(out)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]);
  return out;
}

/** Медианная высота голоса по автокорреляции на озвученных кадрах (16 кГц, 32 мс). */
function pitchStats(wavFile: string): { medianHz: number; p10: number; p90: number; voicedShare: number } {
  const buf = fs.readFileSync(wavFile);
  const data = buf.subarray(44);
  const n = Math.floor(data.length / 2);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  const sr = 16000, frame = 512, hop = 256, minLag = Math.floor(sr / 400), maxLag = Math.floor(sr / 70);
  const f0: number[] = [];
  let frames = 0;
  for (let start = 0; start + frame < n; start += hop) {
    frames++;
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += s[start + i] * s[start + i];
    energy /= frame;
    if (energy < 1e-4) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i < frame - lag; i++) acc += s[start + i] * s[start + i + lag];
      if (acc > best) { best = acc; bestLag = lag; }
    }
    const norm = best / (energy * (frame - bestLag));
    if (bestLag && norm > 0.6) f0.push(sr / bestLag);
  }
  f0.sort((a, b) => a - b);
  const q = (p: number) => (f0.length ? f0[Math.min(f0.length - 1, Math.floor(f0.length * p))] : 0);
  return { medianHz: Math.round(q(0.5)), p10: Math.round(q(0.1)), p90: Math.round(q(0.9)), voicedShare: frames ? Number((f0.length / frames).toFixed(2)) : 0 };
}

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => /^reel-\d+\.mp4$/.test(f)).sort();
  const perReel: any[] = [];
  const allWords: Word[] = [];
  const allGaps: number[] = [];
  const sentenceLens: number[] = [];
  let fillerCount = 0;
  let speakingSec = 0;
  for (const f of files) {
    const w = wav(path.join(DIR, f));
    const wordsFile = path.join(DIR, f.replace(/\.mp4$/, ".words.json"));
    let words: Word[];
    if (fs.existsSync(wordsFile)) words = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
    else {
      words = (await scribeTranscribe(w)) ?? [];
      fs.writeFileSync(wordsFile, JSON.stringify(words), "utf8");
    }
    const gaps: number[] = [];
    for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, words[i].start - words[i - 1].end));
    const speak = words.reduce((s, x) => s + (x.end - x.start), 0) + gaps.filter((g) => g < 1).reduce((s, g) => s + g, 0);
    speakingSec += speak;
    allWords.push(...words);
    allGaps.push(...gaps);
    let cur = 0;
    for (const x of words) { cur++; if (/[.!?…]$/.test(x.word)) { sentenceLens.push(cur); cur = 0; } }
    const text = words.map((x) => x.word.toLowerCase()).join(" ");
    for (const fl of FILLERS) fillerCount += (text.match(new RegExp(`(^| )${fl}( |$)`, "g")) ?? []).length;
    const pitch = pitchStats(w);
    const stats = String(execFileSync("ffmpeg", ["-v", "info", "-i", w, "-af", "astats=measure_overall=RMS_level+Peak_level:measure_perchannel=none", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }));
    const rms = Number((stats.match(/RMS level dB: (-?[\d.]+)/) ?? [])[1] ?? 0);
    const peak = Number((stats.match(/Peak level dB: (-?[\d.]+)/) ?? [])[1] ?? 0);
    const dur = words.length ? words[words.length - 1].end : 0;
    perReel.push({ file: f, words: words.length, durationSec: Number(dur.toFixed(1)), wpm: speak ? Math.round(words.length / (speak / 60)) : 0, pitch, rmsDb: rms, peakDb: peak });
    console.log(`${f}: ${words.length} слов, ${dur.toFixed(0)} с, темп ${speak ? Math.round(words.length / (speak / 60)) : 0} слов/мин, голос ${pitch.medianHz} Гц (${pitch.p10}–${pitch.p90}), RMS ${rms} дБ`);
  }
  const sorted = [...allGaps].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  const longPauses = allGaps.filter((g) => g >= 0.6);
  const sLens = [...sentenceLens].sort((a, b) => a - b);
  const wpm = speakingSec ? Math.round(allWords.length / (speakingSec / 60)) : 0;
  const profile = {
    source: "instagram reels gudov.alex, 4 публичных ролика",
    createdAt: new Date().toISOString(),
    wordsTotal: allWords.length,
    speakingSec: Number(speakingSec.toFixed(1)),
    wordsPerMinute: wpm,
    wordsPer60s: wpm,
    pauseBetweenWordsSec: { median: Number(q(0.5).toFixed(2)), p90: Number(q(0.9).toFixed(2)) },
    longPauses: { count: longPauses.length, perMinute: speakingSec ? Number((longPauses.length / (speakingSec / 60)).toFixed(1)) : 0, medianSec: longPauses.length ? Number(longPauses.sort((a, b) => a - b)[Math.floor(longPauses.length / 2)].toFixed(2)) : 0 },
    sentenceWords: { median: sLens.length ? sLens[Math.floor(sLens.length / 2)] : 0, p90: sLens.length ? sLens[Math.floor(sLens.length * 0.9)] : 0, count: sLens.length },
    fillersPerMinute: speakingSec ? Number((fillerCount / (speakingSec / 60)).toFixed(1)) : 0,
    pitchHz: { median: Math.round(perReel.reduce((s, r) => s + r.pitch.medianHz, 0) / perReel.length), low: Math.min(...perReel.map((r) => r.pitch.p10)), high: Math.max(...perReel.map((r) => r.pitch.p90)) },
    loudness: { rmsDb: Number((perReel.reduce((s, r) => s + r.rmsDb, 0) / perReel.length).toFixed(1)), peakDb: Math.max(...perReel.map((r) => r.peakDb)) },
    perReel,
  };
  fs.writeFileSync(path.join(DIR, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
  console.log("\nPROFILE", JSON.stringify({ ...profile, perReel: undefined }, null, 2));
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
