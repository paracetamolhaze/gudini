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

/**
 * Полная версия V4-промпта БЕЗ ужатия под лимит Runway (1000) — для провайдеров
 * без ограничения длины (OpenRouter и т.п.). Те же секции, тот же порядок,
 * та же семантика; отличается только развёрнутостью формулировок.
 */
export function buildCoverImagePromptFull(concept: CoverConcept): string {
  const pos =
    concept.composition.facePosition === "center"
      ? "centered"
      : `positioned slightly to the ${concept.composition.facePosition}`;
  const scale = concept.composition.faceScale === "very_large" ? "approximately 65%" : "approximately 55%";

  const identity =
    "Use the attached reference photo strictly as the IDENTITY reference for the main person. " +
    "Preserve the exact recognizable identity: facial structure, eyes, eyebrows, nose, lips, jawline, " +
    "skin tone, hairline, hairstyle, hair color, approximate age and defining facial features. " +
    "The person must clearly remain the same individual as in the reference. " +
    "Do NOT copy the reference photo's expression, head angle, pose, clothing, lighting or composition — " +
    "the reference defines WHO this person is, not what this image looks like.";

  const composition =
    `Vertical 9:16 frame. Very large chest-up portrait: head and upper torso only, the person occupies ${scale} ` +
    `of the frame and is ${pos}` +
    (concept.scene.mainSubject ? `; ${concept.scene.mainSubject}` : "") +
    ". The face is one of the two dominant visual elements of the image.";

  const expression =
    `Expression: ${concept.emotion || "tense realization"}. ` +
    "It must look like a real photographed human reaction: natural facial muscle tension, " +
    "no cartoon exaggeration, no extreme open mouth, no impossible facial deformation.";

  const story =
    `Story: exactly one main story object — ${concept.scene.storyObject} — in one environment: ${concept.scene.environment}. ` +
    "The background must look like a believable photographed place: slightly out of focus, detailed enough " +
    "to understand the story, but never sharper or visually louder than the face. No clutter, no extra symbols.";

  const photography =
    "Create a highly photorealistic editorial photograph: premium commercial portrait photography, " +
    "professional thumbnail photography, realistic photo composite with high-end retouch. " +
    "Real human skin texture with visible natural pores, sharp eyelashes, individual hair strands, " +
    "natural facial detail, tack-sharp eyes, realistic optical depth and shadows, real photographic lens " +
    "behaviour. 85mm portrait lens, shallow depth of field, high micro-detail.";

  const lighting =
    "Natural dramatic photographic lighting. Background light may influence the face subtly, but skin " +
    "tones must remain believable. No neon lighting, no fantasy glow, no excessive blue or red color " +
    "cast, no glowing edge around the person, no cyberpunk lighting.";

  const anatomy =
    "Correct human anatomy. No extra, fused, duplicated or malformed fingers; no extra limbs, distorted " +
    "arms or duplicated body parts; no warped eyes, broken pupils, malformed teeth or duplicated facial " +
    "features." +
    (concept.composition.allowHands
      ? ""
      : " NO HANDS OR FINGERS VISIBLE IN FRAME: crop the composition so hands are outside the frame; " +
        "do not invent hand gestures.");

  const negatives =
    "Strictly not: digital painting, illustration, CGI render, 3D render, video game poster, fantasy " +
    "artwork, comic style, anime, plastic or waxy skin, beauty filter, excessive HDR, neon, glow, " +
    "cyberpunk, floating particles, lens flare overload, futuristic interfaces, fake HUD, random warning icons.";

  const noText =
    "No readable text, no letters, no numbers, no logos, no watermarks, no captions, no UI labels anywhere.";

  const safeArea =
    "Keep approximately the lower 35% of the frame visually simple enough for a massive headline overlay: " +
    "do not place the face, eyes or the main story object inside that area, but do not leave it empty — " +
    "it should contain natural torso and background information.";

  return [identity, composition, expression, story, photography, lighting, anatomy, negatives, noText, safeArea].join(
    " ",
  );
}

/** Обрезка по границе слова (не режем слова посередине). */
function clipWords(text: string | undefined, max: number): string {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut.slice(0, max)).replace(/[,;:\s]+$/, "");
}
