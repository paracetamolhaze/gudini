import React from "react";
import { Audio } from "@remotion/media";
import { interpolate, Sequence, staticFile, useVideoConfig } from "remotion";
import { useInput, type Word } from "../input";
import { useClipOffset } from "./time";

/** Sound roles: the folder names of the library (see assets/astra/sounds/README.md). */
export type SfxRole =
  | "whoosh" | "pop" | "click" | "typing" | "ding" | "error" | "cash" | "notification"
  | "riser" | "impact" | "glitch" | "swipe" | "shutter" | "tick";
export type MusicMood = "calm" | "curious" | "upbeat" | "tense" | "dramatic" | "playful";

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Same moment and role always give the same file, different moments vary. */
export function pickFile(files: string[] | undefined, seed: string): string | null {
  if (!files?.length) return null;
  return files[hash(seed) % files.length];
}

/** How loud each role sits under a voice normalized to -16 LUFS (files are levelled to the same peak). */
const ROLE_VOLUME: Record<SfxRole, number> = {
  whoosh: 0.38, swipe: 0.34, pop: 0.34, click: 0.3, typing: 0.26, tick: 0.26, ding: 0.42, error: 0.4,
  cash: 0.42, notification: 0.42, riser: 0.34, impact: 0.55, glitch: 0.32, shutter: 0.38,
};
/** Loops like ticking and typing play only this long unless a duration is given. */
const DEFAULT_SECONDS: Partial<Record<SfxRole, number>> = { tick: 2, typing: 2 };

/**
 * One sound effect at `at` seconds. A riser is placed so that its peak lands exactly on `at`.
 * Silent when the library has no file for the role yet, so a montage never fails because a folder is empty.
 */
export const Sfx: React.FC<{ at: number; role: SfxRole; volume?: number; duration?: number }> = ({ at, role, volume, duration }) => {
  const { sounds, soundInfo } = useInput();
  const { fps } = useVideoConfig();
  const offset = useClipOffset();
  const file = pickFile(sounds[role], `${role}:${at.toFixed(2)}`);
  if (!file) return null;
  const length = soundInfo[file]?.duration ?? 1;
  const start = role === "riser" ? Math.max(0, at - length) : at;
  const play = Math.min(length, duration ?? DEFAULT_SECONDS[role] ?? length);
  const frames = Math.max(1, Math.round(play * fps));
  const level = volume ?? ROLE_VOLUME[role];
  const fadeFrames = Math.round(0.12 * fps);
  return (
    <Sequence from={Math.max(0, Math.round(start * fps)) - offset} durationInFrames={frames} name={`sfx ${role}`} layout="none">
      <Audio src={staticFile(file)} volume={f => level * interpolate(f, [frames - fadeFrames, frames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
    </Sequence>
  );
};

/** Intervals where the author is talking; short gaps are merged so music does not pump. */
export function speechIntervals(words: Word[], mergeGap = 0.6): [number, number][] {
  const spans: [number, number][] = [];
  for (const w of words) {
    const last = spans[spans.length - 1];
    if (last && w.start - last[1] < mergeGap) last[1] = Math.max(last[1], w.end);
    else spans.push([w.start, w.end]);
  }
  return spans;
}

/**
 * Background music under the voice. It ducks while the author talks and breathes in pauses.
 * `from`/`to` in seconds; by default the whole video.
 */
export const Music: React.FC<{ mood: MusicMood; from?: number; to?: number; volume?: number; duck?: number }> = ({
  mood, from = 0, to, volume = 0.16, duck = 0.055,
}) => {
  const input = useInput();
  const { fps } = useVideoConfig();
  const offset = useClipOffset();
  const file = pickFile(input.music[mood], `music:${mood}`);
  if (!file) return null;
  const end = Math.min(to ?? input.duration, input.duration);
  const spans = speechIntervals(input.words);
  const level = (t: number) => {
    let talking = 0;
    for (const [a, b] of spans) talking = Math.max(talking, interpolate(t, [a - 0.25, a, b, b + 0.35], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    const fade = Math.min(interpolate(t, [from, from + 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      interpolate(t, [end - 1.5, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    return (volume + (duck - volume) * talking) * fade;
  };
  const start = Math.round(from * fps);
  return (
    <Sequence from={start - offset} durationInFrames={Math.max(1, Math.round(end * fps) - start)} name={`music ${mood}`} layout="none">
      <Audio src={staticFile(file)} loop volume={(f) => level(from + f / fps)} />
    </Sequence>
  );
};

/** Default sound for a block; `false` turns it off, a role replaces it. */
export const BlockSfx: React.FC<{ at: number; sfx: SfxRole | false | undefined; fallback: SfxRole; volume?: number }> = ({ at, sfx, fallback, volume }) =>
  sfx === false ? null : <Sfx at={at} role={sfx ?? fallback} volume={volume} />;
