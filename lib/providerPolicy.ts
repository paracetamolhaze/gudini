import { CostStage, CostProvider } from "./costLedger";

/**
 * Жёсткое закрепление провайдеров за стадиями.
 *
 * Это не предпочтение и не порядок фолбэка. Провайдер, временно оказавшийся
 * доступным, не становится подходящим: подмена на ходу меняет качество и цену
 * ролика молча, и понять постфактум, чем именно он собран, уже невозможно.
 * Поэтому недоступность своего провайдера — это остановка задачи, а не переход
 * на чужого.
 *
 * OpenRouter — только обложки. Anthropic — понимание истории и монтаж.
 * Brave — только поиск. Расшифровка речи — только ASR-провайдер.
 */

export class ProviderPolicyError extends Error {
  constructor(
    readonly stage: CostStage,
    readonly attempted: CostProvider,
    readonly allowed: CostProvider[],
  ) {
    super(
      `Нарушение политики провайдеров: стадия «${stage}» обратилась к ${attempted}, ` +
        `а ей разрешён только ${allowed.join(" / ")}. Автоматическая подмена провайдера запрещена.`,
    );
    this.name = "ProviderPolicyError";
  }
}

/** Кто имеет право обслуживать каждую стадию. */
export const STAGE_PROVIDERS: Record<CostStage, CostProvider[]> = {
  // понимание истории и монтаж
  "Story Research": ["anthropic"],
  "Script Generation": ["anthropic"],
  "Script Beats": ["anthropic"],
  "Media Research": ["anthropic", "brave"],
  "Source Verification": ["anthropic"],
  "Vision Verification": ["anthropic"],
  "Beat Matching": ["anthropic"],
  "Creative Director": ["anthropic"],
  "Speech Cleanup": ["anthropic"],
  Metadata: ["anthropic"],
  // расшифровка речи — отдельный провайдер и только она
  Transcription: ["elevenlabs", "openai"],
  // обложки — единственное место, где разрешён OpenRouter
  "Cover Concept": ["openrouter", "anthropic"],
  "Cover Generation": ["openrouter"],
  "Cover QC": ["openrouter", "anthropic"],
};

/** Стадии, относящиеся к обложке: только им позволен OpenRouter. */
export const COVER_STAGES: CostStage[] = ["Cover Concept", "Cover Generation", "Cover QC"];

/** Стадии поиска: только им позволен Brave. */
export const SEARCH_STAGES: CostStage[] = ["Media Research"];

export type PolicyViolation = { stage: CostStage; provider: CostProvider; at: string };

const violations: PolicyViolation[] = [];

export function policyViolations(): PolicyViolation[] {
  return violations.map((v) => ({ ...v }));
}

export function resetPolicyViolations(): void {
  violations.length = 0;
}

/**
 * Проверяет пару «стадия — провайдер» и бросает, если она запрещена.
 * Нарушение при этом ещё и запоминается: отчёт обязан показать его явно,
 * даже если кто-то выше по стеку ошибку поймает.
 */
export function assertProvider(stage: CostStage, provider: CostProvider): void {
  const allowed = STAGE_PROVIDERS[stage];
  if (!allowed) throw new Error(`Неизвестная стадия для политики провайдеров: ${stage}`);
  if (allowed.includes(provider)) return;
  violations.push({ stage, provider, at: new Date().toISOString() });
  throw new ProviderPolicyError(stage, provider, allowed);
}

/** Разрешён ли провайдер стадии — без броска, для отчётов и проверок. */
export function isAllowed(stage: CostStage, provider: CostProvider): boolean {
  return (STAGE_PROVIDERS[stage] ?? []).includes(provider);
}
