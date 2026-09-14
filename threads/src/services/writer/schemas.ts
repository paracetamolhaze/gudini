import { z } from "zod";

export const draftVariantSchema = z.object({
  type: z.enum(["NEWS", "OPINION", "EXPLAINER", "HOT_TAKE", "SHORT"]),
  hook: z.string().min(5).max(300).describe("Первый абзац: почему это стоит прочитать"),
  body: z.string().max(2500).describe("Остальной текст поста (может быть пустым для SHORT)"),
  usedFacts: z.array(z.number().int().min(0)).max(20).describe("Индексы фактов из списка, которые использованы в тексте"),
  hedgedFacts: z.array(z.number().int().min(0)).max(20).describe("Индексы фактов, которые поданы с оговоркой/атрибуцией"),
  confidence: z.number().min(0).max(100).describe("Насколько текст точно передаёт факты без искажений"),
  selfCheck: z.string().max(400).describe("Кратко: какие числа использованы и откуда они"),
});
export type DraftVariant = z.infer<typeof draftVariantSchema>;

export const writerOutputSchema = z.object({
  variants: z.array(draftVariantSchema).min(1).max(3),
});
export type WriterOutput = z.infer<typeof writerOutputSchema>;

export function variantText(v: DraftVariant): string {
  const body = v.body.trim();
  return body ? `${v.hook.trim()}\n\n${body}` : v.hook.trim();
}
