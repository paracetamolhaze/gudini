import fs from "fs";
import path from "path";
import { runFfmpeg } from "../ffmpeg";
import { hasMusic, MUSIC_FILE } from "../store";
import { CARD, CARD_FILTER } from "../topInset";
import type { AiFilmPlan, GroupClip, TimelineSegment } from "./types";

/**
 * Финальная сборка v2: одна дорожка автора целиком (видео и голос), поверх неё в окнах
 * таймлайна — клипы групп. FULL_AI: клип 9:16 на весь кадр 1080×1920. HYBRID: клип в
 * карточке сверху, как в обычном стиле (та же геометрия CARD). Субтитры (ass) — самым
 * верхним слоем, поэтому идут и на авторе, и на AI. Звук берётся только из автора той же
 * цепочкой, что в обычном монтаже: переключения видеоряда его не касаются.
 */

export const FILM_W = 1080;
export const FILM_H = 1920;
export const FILM_FPS = 30;

export type Overlay = { segment: TimelineSegment; clip: GroupClip };

/** Окна наложения: по AI-сегментам таймлайна, клип группы стартует с начала группы. */
export function overlaysFor(plan: AiFilmPlan, clips: GroupClip[]): Overlay[] {
  const byGroup = new Map(clips.map((c) => [c.groupId, c]));
  const out: Overlay[] = [];
  for (const seg of plan.timeline) {
    if (seg.mode === "author" || !seg.groupId) continue;
    const clip = byGroup.get(seg.groupId);
    if (!clip) throw new Error(`AI-фильм: для группы ${seg.groupId} нет клипа`);
    const group = plan.groups.find((g) => g.id === seg.groupId)!;
    if (clip.seconds + 0.5 < group.end - group.start) {
      throw new Error(`AI-фильм: клип группы ${seg.groupId} короче своего отрезка (${clip.seconds.toFixed(1)} с < ${(group.end - group.start).toFixed(1)} с)`);
    }
    out.push({ segment: seg, clip });
  }
  return out;
}

/**
 * Фильтр видео: [0:v] автор → наложения → субтитры. Индексы входов клипов начинаются с
 * firstInput (1 без музыки, 2 с музыкой). Клип обрезается под окно и сдвигается по PTS
 * на начало окна; enable ограничивает показ окном — жёсткая склейка без эффектов.
 */
export function compositeFilter(fit: string, overlays: Overlay[], plan: AiFilmPlan, firstInput: number, subs = "subs.ass"): string {
  let chain = `[0:v]${fit},fps=${FILM_FPS}[vbase]`;
  let current = "vbase";
  overlays.forEach((o, k) => {
    const group = plan.groups.find((g) => g.id === o.segment.groupId)!;
    const inputIdx = firstInput + k;
    const offset = Math.max(0, o.segment.start - group.start); // окно может начинаться не с начала клипа группы
    const len = o.segment.end - o.segment.start;
    const scaled =
      o.segment.mode === "full_ai"
        ? `scale=${FILM_W}:${FILM_H}:force_original_aspect_ratio=increase,crop=${FILM_W}:${FILM_H},setsar=1`
        : `${CARD_FILTER},setsar=1`;
    const pos = o.segment.mode === "full_ai" ? "0:0" : `${CARD.x}:${CARD.y}`;
    chain +=
      `;[${inputIdx}:v]${scaled},fps=${FILM_FPS},trim=start=${offset.toFixed(3)}:duration=${len.toFixed(3)},` +
      `tpad=stop_mode=clone:stop_duration=2,trim=duration=${len.toFixed(3)},setpts=PTS-STARTPTS+${o.segment.start.toFixed(3)}/TB[ai${k}]` +
      `;[${current}][ai${k}]overlay=${pos}:eof_action=pass:enable='between(t,${o.segment.start.toFixed(3)},${o.segment.end.toFixed(3)})'[vo${k}]`;
    current = `vo${k}`;
  });
  chain += `;[${current}]ass=${subs}[v]`;
  return chain;
}

/** Звук: только автор, той же цепочкой, что в обычном монтаже; музыка — вход 1. */
export function audioFilter(music: boolean): string {
  const voice = "afftdn=nr=10:nf=-45:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";
  return music
    ? `[0:a]${voice},asplit=2[vo][sidechain];[1:a]volume=0.22,aresample=48000[mus];[mus][sidechain]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];[vo][duck]amix=inputs=2:duration=first:normalize=0[a]`
    : `[0:a]${voice}[a]`;
}

export async function renderFilmComposite(
  dir: string,
  source: string,
  plan: AiFilmPlan,
  clips: GroupClip[],
  effDur: number,
  onProgress: (f: number) => void,
  opts: { threads: number; fit: string },
): Promise<void> {
  const music = hasMusic();
  if (!fs.existsSync(path.join(dir, "subs.ass"))) throw new Error("AI-фильм: нет файла субтитров");
  const overlays = overlaysFor(plan, clips);
  for (const o of overlays) {
    if (!fs.existsSync(path.join(dir, o.clip.file))) throw new Error(`AI-фильм: нет файла клипа ${o.clip.file}`);
  }
  const firstInput = music ? 2 : 1;
  await runFfmpeg(
    [
      "-i", source,
      ...(music ? ["-stream_loop", "-1", "-i", MUSIC_FILE] : []),
      ...overlays.flatMap((o) => ["-i", o.clip.file]),
      "-filter_complex", `${compositeFilter(opts.fit, overlays, plan, firstInput)};${audioFilter(music)}`,
      "-map", "[v]", "-map", "[a]",
      "-threads", String(opts.threads),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-ar", "48000", "-b:a", "192k",
      "-movflags", "+faststart",
      ...(music ? ["-shortest"] : []),
      "out.mp4",
    ],
    { cwd: dir, totalDurationSec: effDur, onProgress },
  );
}
