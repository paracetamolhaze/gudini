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

// ===== Full-AI Cover: image-модель рисует ГОТОВУЮ обложку, включая типографику =====

const TYPOGRAPHY_DIRECTIONS: Record<string, string> = {
  BOTTOM_MASSIVE:
    "Stack the headline as a massive multi-line block across the lower third, nearly full width of the frame.",
  SIDE_STACK:
    "Stack the headline vertically beside the face, filling the empty side of the composition.",
  ONE_WORD_DOMINANT:
    "Make one word of the headline gigantic and dominant, with the remaining words much smaller near it.",
  ACCENT_BOX:
    "Set one key word of the headline in black letters on a warm-yellow box; the other words in white.",
  INTEGRATED_POSTER:
    "Integrate the headline into the scene like designed poster art; letters may pass partially behind the person.",
};

/**
 * Промпт полной обложки: FACE + SCENE + TYPOGRAPHY одной генерацией.
 * Секции: IDENTITY → STORY → COMPOSITION → EXPRESSION → PHOTOGRAPHY → TYPOGRAPHY →
 * EXACT TEXT → ANATOMY → NEGATIVES. Запрет текста и safe-area здесь НЕ используются.
 */
export function buildFullCoverPrompt(concept: CoverConcept): string {
  const pos =
    concept.composition.facePosition === "center"
      ? "centered"
      : `positioned slightly to the ${concept.composition.facePosition}`;
  const scale = concept.composition.faceScale === "very_large" ? "approximately 65%" : "approximately 55%";
  const headline = concept.headlineLines.map((l) => l.text).join("\n");

  const identity =
    "Use the attached reference photo strictly as the IDENTITY reference for the main person: preserve the " +
    "recognizable identity — facial structure, eyes, eyebrows, nose, lips, jawline, skin tone, hairstyle, " +
    "hair color, approximate age and defining features. The person must clearly remain the same individual. " +
    "Do NOT copy the reference photo's expression, pose, clothing, lighting or composition.";

  const story =
    `Story: exactly one main story object — ${concept.scene.storyObject} — in one environment: ${concept.scene.environment}. ` +
    "The background must read as a believable photographed place, slightly out of focus, never louder than the face.";

  const composition =
    `Vertical 9:16 viral cover. Very large chest-up portrait, head and upper torso only, the person occupies ${scale} ` +
    `of the frame, ${pos}` +
    (concept.scene.mainSubject ? `; ${concept.scene.mainSubject}` : "") +
    ". The face and the headline are the two dominant visual elements.";

  const expression =
    `Expression: ${concept.emotion || "tense realization"} — a real photographed human reaction, natural muscle ` +
    "tension, no cartoon exaggeration.";

  const photography =
    "Highly photorealistic editorial photograph: premium portrait photography, real skin texture with visible " +
    "pores, sharp eyelashes, individual hair strands, tack-sharp eyes, realistic optics and shadows, 85mm lens, " +
    "shallow depth of field, professional key-art retouch.";

  const typography =
    "Create the complete final vertical social-media cover, including professionally designed Russian typography. " +
    "The typography must be an integral part of the composition, not a generic text overlay. " +
    "Use extremely bold condensed Cyrillic display typography. The headline must be huge, immediately readable at " +
    "thumbnail size, with tight line spacing and strong hierarchy. Use white, warm yellow and black as the primary " +
    "typography palette. You may use white text, yellow accent text, a yellow box with black text, different word " +
    "sizes, asymmetrical typography, and text integrated around the subject. " +
    "Do not force the same layout on every cover. " +
    (TYPOGRAPHY_DIRECTIONS[concept.typographyDirection ?? "BOTTOM_MASSIVE"] ?? TYPOGRAPHY_DIRECTIONS.BOTTOM_MASSIVE);

  const exactText =
    `The ONLY readable text allowed anywhere in the image is:\n"${headline}"\n` +
    (concept.kicker ? `plus one small kicker: "${concept.kicker.toUpperCase()}"\n` : "") +
    "Render these exact Russian words correctly. The line breaks above are preferred, but you may adjust " +
    "the layout as long as every word stays exactly as written. Do not replace words, do not invent " +
    "additional words, do not translate, do not misspell Cyrillic.\n" +
    "Do not add any other readable words, letters, labels, captions, signs, badges, logos, numbers, " +
    "fake interface elements or pseudo-text anywhere in the image.";

  const anatomy =
    "Correct human anatomy: no extra, fused or malformed fingers, no extra limbs, no warped eyes, no malformed " +
    "teeth, no duplicated features." +
    (concept.composition.allowHands
      ? ""
      : " NO HANDS OR FINGERS VISIBLE IN FRAME — crop the composition so hands are outside; do not invent gestures.");

  const negatives =
    "Strictly not: digital painting, illustration, CGI, 3D render, video game poster, fantasy artwork, comic or " +
    "anime style, plastic or waxy skin, beauty filter, excessive HDR, neon, glow, cyberpunk, floating particles, " +
    "fake HUD or random interface elements.";

  return [identity, story, composition, expression, photography, typography, exactText, anatomy, negatives].join(" ");
}

/** Обрезка по границе слова (не режем слова посередине). */
function clipWords(text: string | undefined, max: number): string {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut.slice(0, max)).replace(/[,;:\s]+$/, "");
}
