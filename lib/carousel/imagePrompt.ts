import type { CarouselFormat, DesignSettings, Slide, VisualConcept } from "./types";

/**
 * Промпты генератора изображений. Смысл конкретного слайда задаёт Claude (brief и composition),
 * а общая часть серии — стиль, палитра, свет, персонажи — одинаковая для всех слайдов и
 * подкрепляется референсом: уже одобренной картинкой серии и референсом аккаунта.
 *
 * Текст на карточке рисует сайт, поэтому генератор просят оставить спокойную зону под текст
 * и не рисовать никаких надписей.
 */

export type PromptRefs = { anchor: boolean; account: boolean };

const zoneWord = (placement: "top" | "bottom") => (placement === "top" ? "upper" : "lower");

function seriesLines(visual: VisualConcept | undefined, design: Pick<DesignSettings, "illustrationStyle">): string[] {
  const v = visual;
  const lines: string[] = [];
  if (v?.style) lines.push(`Art direction for the whole series: ${v.style}.`);
  if (v?.palette) lines.push(`Palette: ${v.palette}.`);
  if (v?.lighting) lines.push(`Lighting: ${v.lighting}.`);
  if (design.illustrationStyle) lines.push(`Preferred illustration style of the account (author's words): ${design.illustrationStyle}.`);
  if (v?.characters?.length) {
    lines.push(`Recurring characters — keep exactly the same appearance, age, clothing and proportions on every slide: ${v.characters.map((c) => `${c.name}: ${c.look}`).join("; ")}.`);
  }
  if (v?.objects?.length) lines.push(`Recurring objects, drawn the same way each time: ${v.objects.join("; ")}.`);
  return lines;
}

const NO_TEXT = "Do not draw any text, letters, numbers, captions, speech bubbles, logos, watermarks, signatures or interface elements.";

export function buildImagePrompt(a: {
  visual: VisualConcept | undefined;
  design: Pick<DesignSettings, "illustrationStyle">;
  slide: Pick<Slide, "kind" | "image">;
  index: number;
  total: number;
  format: CarouselFormat;
  refs: PromptRefs;
}): string {
  const img = a.slide.image;
  if (!img) throw new Error("у слайда нет описания иллюстрации");
  const lines = [
    `Illustration for slide ${a.index + 1} of ${a.total} of one Instagram carousel series.`,
    ...seriesLines(a.visual, a.design),
    `What this particular slide shows: ${img.brief}`,
    img.composition ? `Composition: ${img.composition}.` : "",
    `Keep the ${zoneWord(img.textPlacement)} 40% of the frame visually calm and uncluttered — soft background, no faces or key details there — because a headline will be placed over that area later.`,
    a.refs.anchor
      ? "Reference image 1 is an already approved slide of this same series: match its art style, palette, lighting, rendering technique and the look of recurring characters exactly, but build a new composition for this slide; do not copy its layout."
      : "",
    a.refs.account
      ? `${a.refs.anchor ? "The next reference image" : "The reference image"} shows the account's preferred visual style: follow its style and mood only, do not copy its content.`
      : "",
    NO_TEXT,
    a.format === "square" ? "Square 1:1 frame." : "Vertical portrait frame.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Правка готовой иллюстрации поручением: первая картинка-референс — текущая версия слайда. */
export function buildEditPrompt(a: { instruction: string; slide: Pick<Slide, "image">; visual: VisualConcept | undefined; hasAnchor: boolean }): string {
  const img = a.slide.image;
  const placement = img?.textPlacement ?? "bottom";
  return [
    "Edit reference image 1 (the current illustration of this slide).",
    `Instruction from the author: ${a.instruction}`,
    "Change only what the instruction asks for. Keep the composition, characters, objects, style, palette and camera angle otherwise identical.",
    a.hasAnchor ? "Reference image 2 is another approved slide of the same series — keep the result consistent with it in style and character appearance." : "",
    a.visual?.style ? `Series art direction: ${a.visual.style}.` : "",
    `Keep the ${zoneWord(placement)} 40% of the frame calm and uncluttered for text.`,
    NO_TEXT,
  ]
    .filter(Boolean)
    .join("\n");
}
