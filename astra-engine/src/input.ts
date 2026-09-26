import { createContext, useContext } from "react";
import { z } from "zod";

export const wordSchema = z.object({ word: z.string(), start: z.number(), end: z.number() });
export type Word = z.infer<typeof wordSchema>;

const box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Everything the pipeline hands to a montage. Paths are relative to the bundle's public folder. */
export const astraInputSchema = z.object({
  duration: z.number().positive(),
  fps: z.number().int().positive().default(30),
  /** Author recording after speech cleanup, 1080x1920. */
  video: z.string(),
  /** Processed voice track; when absent the video's own audio is used. */
  voice: z.string().optional(),
  /**
   * Author cut out of the background (VP9 with alpha) for the stretches that need it.
   * Frame 0 of each file is the video frame at `from`. Enables text behind the author.
   */
  cutouts: z.array(z.object({ from: z.number(), to: z.number(), src: z.string() })).default([]),
  words: z.array(wordSchema),
  /** Typical face box on the 1080x1920 frame: camera zooms toward it, captions and cards keep clear of it. */
  face: box.optional(),
  /** Sound library by role (whoosh, pop, ding...) and music by mood (calm, tense...). */
  sounds: z.record(z.string(), z.array(z.string())).default({}),
  music: z.record(z.string(), z.array(z.string())).default({}),
  /** Length in seconds of every prepared sound, by its path: risers are placed so their peak hits the accent. */
  soundInfo: z.record(z.string(), z.object({ duration: z.number() })).default({}),
  /** Images and logos prepared for this video, by name. */
  assets: z.record(z.string(), z.string()).default({}),
  /** Pixel size of each prepared picture, so the kit can show it whole. */
  sizes: z.record(z.string(), z.object({ w: z.number(), h: z.number() })).default({}),
});
export type AstraInput = z.infer<typeof astraInputSchema>;

export const DEFAULT_FACE = { x: 330, y: 470, w: 420, h: 560 };

export const InputContext = createContext<AstraInput | null>(null);

export function useInput(): AstraInput {
  const input = useContext(InputContext);
  if (!input) throw new Error("Astra blocks must be rendered inside <AstraVideo>");
  return input;
}

export const faceOf = (input: AstraInput) => input.face ?? DEFAULT_FACE;
