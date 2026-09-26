import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUDIO = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

/** Bump when the preparation changes, so cached files are prepared again. */
const PREPARE_VERSION = "background-v2";

/**
 * Loudest moment of each role (EBU R128 momentary, LUFS). The voice runs around -19 LUFS,
 * so effects sit 8-11 dB under it: heard, but behind the voice.
 */
const ROLE_LOUDNESS: Record<string, number> = {
  whoosh: -28, swipe: -28, pop: -28, click: -30, typing: -32, tick: -32, ding: -27, error: -27,
  cash: -27, notification: -26, riser: -29, impact: -25, glitch: -29, shutter: -28,
};

/** Longest useful length of a sound in each role; longer files are cut (risers keep their ending, where the peak is). */
const MAX_SECONDS: Record<string, number> = {
  pop: 1.2, click: 0.8, ding: 2.2, impact: 1.8, shutter: 1.0, notification: 1.8, swipe: 1.2, whoosh: 1.6,
  cash: 2.5, error: 2.2, glitch: 1.2, riser: 4.0, tick: 6.0, typing: 6.0,
};

function run(args: string[]): string {
  try { return execFileSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString(); }
  catch (error: any) { return String(error.stderr ?? error.stdout ?? ""); }
}

const duration = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim()) || 0;
/** ffmpeg analysis filters report on stderr. */
const analysis = (args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8" }).stderr ?? "";
const peak = (file: string) => Number(analysis(["-i", file, "-af", "volumedetect", "-f", "null", "-"]).match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? 0);
/** Loudest 400 ms of a sound; a short sound is padded with silence so it is measured too. */
function momentaryMax(file: string): number {
  const values = [...analysis(["-i", file, "-af", "apad=pad_dur=0.6,ebur128", "-f", "null", "-"]).matchAll(/M:\s*(-?[\d.]+)/g)]
    .map(m => Number(m[1])).filter(v => Number.isFinite(v) && v > -70);
  return values.length ? Math.max(...values) : -40;
}

/**
 * One sound effect made ready for the montage: the silence before and after it is cut, so the sound
 * lands exactly on its frame; overly long files are shortened for the role; the peak is levelled.
 */
function prepareSfx(source: string, role: string, target: string) {
  const trimmed = `${target}.trim.wav`;
  run(["-y", "-i", source, "-af",
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse",
    "-ar", "48000", "-ac", "2", trimmed]);
  const max = MAX_SECONDS[role] ?? 2;
  const length = duration(trimmed);
  const cut = length > max;
  // A riser is kept from its end: the build-up has to reach its peak exactly on the accent.
  const window = role === "riser" && cut ? ["-ss", (length - max).toFixed(3)] : [];
  const fades = cut ? (role === "riser" ? `afade=t=in:d=0.4` : `afade=t=out:st=${(max - 0.12).toFixed(3)}:d=0.12`) : "anull";
  const shaped = `${target}.shape.wav`;
  // Softer highs move an effect back, behind the voice.
  run(["-y", ...window, "-i", trimmed, "-t", String(Math.min(length, max)), "-af", `${fades},highshelf=f=6500:g=-3`, shaped]);
  const gain = Math.min((ROLE_LOUDNESS[role] ?? -28) - momentaryMax(shaped), -6 - peak(shaped));
  run(["-y", "-i", shaped, "-af", `volume=${gain.toFixed(2)}dB`, "-c:a", "pcm_s16le", target]);
  fs.rmSync(trimmed, { force: true });
  fs.rmSync(shaped, { force: true });
}

export type SoundLibrary = {
  sounds: Record<string, string[]>;
  music: Record<string, string[]>;
  /** Length of every prepared file, by its public path. */
  soundInfo: Record<string, { duration: number }>;
};

/**
 * The owner's library (sfx/<role>, music/<mood>) prepared into the bundle's public folder.
 * The owner's files stay untouched; prepared copies are cached by source contents.
 */
export function linkSounds(soundsDir: string | undefined, publicDir: string): SoundLibrary {
  const library: SoundLibrary = { sounds: {}, music: {}, soundInfo: {} };
  if (!soundsDir || !fs.existsSync(soundsDir)) return library;
  const seen = new Set<string>();
  for (const [kind, target] of [["sfx", library.sounds], ["music", library.music]] as const) {
    const base = path.join(soundsDir, kind);
    if (!fs.existsSync(base)) continue;
    for (const role of fs.readdirSync(base)) {
      const dir = path.join(base, role);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir).filter(f => AUDIO.test(f)).sort()) {
        // A riser dropped into another folder by mistake stays a riser.
        if (kind === "sfx" && role !== "riser" && /riser/i.test(file)) continue;
        const source = path.join(dir, file);
        const bytes = fs.readFileSync(source);
        const hash = createHash("sha1").update(bytes).update(role).update(PREPARE_VERSION).digest("hex").slice(0, 10);
        const out = path.join(publicDir, "sounds", kind, role, `${path.parse(file).name.slice(0, 40)}-${hash}.${kind === "sfx" ? "wav" : path.extname(file).slice(1)}`);
        if (!fs.existsSync(out)) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          if (kind === "sfx") prepareSfx(source, role, out);
          else fs.copyFileSync(source, out);
        }
        const rel = path.relative(publicDir, out).split(path.sep).join("/");
        if (seen.has(`${role}:${hash}`)) continue;
        seen.add(`${role}:${hash}`);
        (target[role] ??= []).push(rel);
        library.soundInfo[rel] = { duration: duration(out) };
      }
    }
  }
  return library;
}

/** The author's voice cleaned and brought to TikTok loudness (-16 LUFS), so effects and music sit under it. */
export function prepareVoice(video: string, publicDir: string, subdir: string): string {
  const stat = fs.statSync(video);
  const out = path.join(publicDir, subdir, `voice-${createHash("sha1").update(`${video}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 10)}.wav`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    run(["-y", "-i", video, "-vn", "-af", "afftdn=nr=10:nf=-45:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out]);
  }
  return path.relative(publicDir, out).split(path.sep).join("/");
}
