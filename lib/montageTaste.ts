import fs from "fs";
import path from "path";

/**
 * Профиль монтажа (идея из b-roll-finder TASTE.md и taste.yaml EverythingAI):
 * пропорции, темп и правила лежат в одном файле, а не разбросаны по коду.
 * Это ориентиры для режиссёра и пороги для валидатора, а не бизнес-правила.
 */

export type MontageTaste = {
  target_external_coverage: number;
  preferred_video_share: number;
  min_visual_duration: number;
  typical_visual_duration: number;
  max_visual_duration: number;
  max_exact_event_duration: number;
  max_aroll_gap: number;
  prefer_exact_event: boolean;
  prefer_video_over_image: boolean;
  allow_visual_sequence: boolean;
  max_items_per_beat: number;
  image_motion: "static" | "subtle";
  transitions: "hard_cut";
  captions: string;
  external_audio: "off";
  punch_in: "disabled";
  text_callout: "disabled";
  beat_video_queries: number;
  beat_image_queries: number;
  core_video_queries: number;
  /** сколько лучших по метаданным кандидатов реально качать */
  core_download_shortlist: number;
  max_source_videos: number;
  segments_per_source_video: number;
  min_usable_video_segments: number;
  min_total_assets: number;
  min_beat_coverage: number;
};

const DEFAULTS: MontageTaste = {
  target_external_coverage: 0.6,
  preferred_video_share: 0.7,
  min_visual_duration: 1.5,
  typical_visual_duration: 2.7,
  max_visual_duration: 4.5,
  max_exact_event_duration: 4.5,
  max_aroll_gap: 5.0,
  prefer_exact_event: true,
  prefer_video_over_image: true,
  allow_visual_sequence: true,
  max_items_per_beat: 3,
  image_motion: "subtle",
  transitions: "hard_cut",
  captions: "one_word_white",
  external_audio: "off",
  punch_in: "disabled",
  text_callout: "disabled",
  beat_video_queries: 3,
  beat_image_queries: 2,
  core_video_queries: 6,
  core_download_shortlist: 10,
  max_source_videos: 4,
  segments_per_source_video: 6,
  min_usable_video_segments: 6,
  min_total_assets: 12,
  min_beat_coverage: 0.7,
};

let cached: MontageTaste | null = null;

export function taste(): MontageTaste {
  if (cached) return cached;
  let loaded: MontageTaste = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "montage-taste.json"), "utf8"));
    loaded = { ...DEFAULTS, ...raw };
  } catch {}
  cached = loaded;
  return loaded;
}

/** Для тестов и переопределения в рантайме. */
export function setTaste(patch: Partial<MontageTaste>): void {
  cached = { ...taste(), ...patch };
}
