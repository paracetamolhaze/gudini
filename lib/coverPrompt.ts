import type { CoverConcept } from "./cover";

/**
 * Cover Prompt System v4 — детерминированная сборка image prompt.
 * Claude отдаёт только режиссуру (эмоция, сцена, композиция, руки-да/нет);
 * фотографичность, анатомия, негативы, запрет текста и safe area — фиксированные
 * секции в ПОСТОЯННОМ порядке: IDENTITY → COMPOSITION → EXPRESSION → STORY →
 * PHOTOGRAPHY → LIGHTING → ANATOMY → NEGATIVES+TEXT → SAFE AREA.
 * Жёсткий лимит Runway (1000 символов) заставляет телеграфную плотность;
 * длины секций подобраны по замерам, переменные Claude клампятся.
 */

const IDENTITY =
  "@streamer = identity: same face, eyes, brows, nose, lips, jawline, skin, hair, age; " +
  "never copy its pose, expression, clothes, light.";

const EXPRESSION_GUARD = "real photographed reaction, no cartoon exaggeration";

const PHOTOGRAPHY =
  "Photorealistic pro photo: real skin pores, sharp lashes, hair strands, tack-sharp eyes, " +
  "85mm, shallow depth.";

const LIGHTING = "Natural dramatic light, believable skin tones, no neon/glow/color cast.";

const ANATOMY = "Correct anatomy, no malformed or extra features.";

const NO_HANDS = "NO hands/fingers in frame — crop out, no invented gestures.";

const NEGATIVES_AND_TEXT =
  "No painting/CGI/3D/anime, plastic skin, HDR, neon FX, particles, flares, UI; " +
  "no text, numbers, logos, watermarks.";

const SAFE_AREA =
  "Lower 35% simple for a huge headline: face and story object above, natural torso/background below.";

export function buildCoverImagePrompt(concept: CoverConcept): string {
  const pos =
    concept.composition.facePosition === "center"
      ? "centered"
      : `slightly ${concept.composition.facePosition}`;
  const scale = concept.composition.faceScale === "very_large" ? "~65%" : "~55%";
  const anatomy = concept.composition.allowHands ? ANATOMY : `${ANATOMY} ${NO_HANDS}`;

  // при переполнении лимита (1000) ужимаются ПЕРЕМЕННЫЕ Клода, а не фиксированные секции:
  // каскад бюджетов от щедрого к минимальному, пока всё не влезет вместе с SAFE-хвостом
  const budgets = [
    { subject: 30, emotion: 48, object: 48, env: 36 },
    { subject: 0, emotion: 48, object: 48, env: 36 },
    { subject: 0, emotion: 36, object: 40, env: 28 },
    { subject: 0, emotion: 24, object: 32, env: 22 },
  ];

  for (const b of budgets) {
    const subject = b.subject ? clipWords(concept.scene.mainSubject, b.subject) : "";
    const composition =
      `Vertical 9:16 chest-up, head and torso only, ${scale} of frame, ${pos}` +
      (subject ? `, ${subject}` : "") +
      ".";
    const expression = `Expression: ${clipWords(concept.emotion, b.emotion) || "tense realization"} — ${EXPRESSION_GUARD}.`;
    const story =
      `Story: ${clipWords(concept.scene.storyObject, b.object)} in ${clipWords(concept.scene.environment, b.env)}; ` +
      "defocused real background, calmer than face, no clutter.";

    const prompt = [
      IDENTITY,
      composition,
      expression,
      story,
      PHOTOGRAPHY,
      LIGHTING,
      anatomy,
      NEGATIVES_AND_TEXT,
      SAFE_AREA,
    ].join(" ");
    if (prompt.length <= 1000) return prompt;
  }

  // теоретически недостижимо (минимальный бюджет всегда влезает) — жёсткая страховка
  const minimal = budgets[budgets.length - 1];
  return [IDENTITY, PHOTOGRAPHY, anatomy, NEGATIVES_AND_TEXT, SAFE_AREA].join(" ").slice(0, 1000);
}

/** Обрезка по границе слова (не режем слова посередине). */
function clipWords(text: string | undefined, max: number): string {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut.slice(0, max)).replace(/[,;:\s]+$/, "");
}
