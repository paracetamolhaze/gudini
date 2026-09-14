import { z } from "zod";

/** Coordinates are normalised to a 0–1000 grid on both axes so the model does not need pixel sizes. */
export const bboxSchema = z.object({
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  w: z.number().min(1).max(1000),
  h: z.number().min(1).max(1000),
});

export const BLOCK_ROLES = ["headline", "subheadline", "body", "caption", "label", "number", "ticker", "url", "brand", "watermark", "username", "ui", "other"] as const;

export const ocrBlockSchema = z.object({
  id: z.number().int().min(0),
  text: z.string().min(1).max(600),
  bbox: bboxSchema,
  role: z.enum(BLOCK_ROLES),
  language: z.string().max(10).describe("ISO code, e.g. en, ru"),
  fontSize: z.number().min(1).max(1000).describe("Approximate cap height of the text in 0–1000 grid units of image height"),
  bold: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Dominant text colour, hex"),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Dominant background colour behind the text, hex"),
  alignment: z.enum(["left", "center", "right"]),
  rotation: z.number().min(-180).max(180),
  confidence: z.number().min(0).max(1),
  lines: z.number().int().min(1).max(20).describe("How many visual lines the block spans"),
});
export type OcrBlock = z.infer<typeof ocrBlockSchema>;

export const ocrResultSchema = z.object({
  hasText: z.boolean(),
  imageDescription: z.string().max(600).describe("What the image shows (chart, screenshot, meme, infographic…)"),
  blocks: z.array(ocrBlockSchema).max(60),
});
export type OcrResult = z.infer<typeof ocrResultSchema>;

export const translationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.number().int().min(0),
      text: z.string().min(1).max(600).describe("Natural Russian for this block; numbers, tickers and names kept exactly"),
      shorter: z.string().min(1).max(600).describe("A shorter Russian alternative for tight layouts"),
    }),
  ),
});
export type TranslationResult = z.infer<typeof translationSchema>;

export interface PlacedBlock extends OcrBlock {
  translate: boolean;
  skipReason?: string;
  translation?: string;
  shorter?: string;
  rendered?: { fontPx: number; lines: string[]; usedShorter: boolean; overflow: boolean };
}

export interface ImageQaResult {
  passed: boolean;
  issues: string[];
  cyrillicRatio: number;
  numbersMissing: string[];
  englishLeft: string[];
}
