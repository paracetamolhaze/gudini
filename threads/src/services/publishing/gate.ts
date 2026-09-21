import type { Mode } from "../../config/settings.js";

/**
 * Whether a draft may go out, and by which door. Pure so the rules are testable:
 *   kill switch / OFF / expired      → BLOCK
 *   manual (human pressed Publish)   → PUBLISH in DRAFT/REVIEW/AUTO
 *   automatic                        → PUBLISH only in AUTO with autoPost on and the risk gate passed,
 *                                      otherwise REVIEW (human) or HOLD (mode does not publish)
 */
export type GateRoute = "PUBLISH" | "REVIEW" | "HOLD" | "BLOCK";

export interface GateInput {
  mode: Mode;
  killSwitch: boolean;
  autoPostEnabled: boolean;
  manual: boolean;
  draft: {
    status: string;
    riskScore: number | null;
    confidence: number | null;
    totalScore: number | null;
    expiresAt: Date | null;
    reviewReason: string | null;
  };
  thresholds: { maxRisk: number; minConfidence: number; minScore: number };
  now?: Date;
}

export function decidePublish(input: GateInput): { route: GateRoute; reason: string } {
  const now = input.now ?? new Date();
  if (input.killSwitch) return { route: "BLOCK", reason: "kill switch включён" };
  if (input.mode === "OFF") return { route: "BLOCK", reason: "режим OFF" };
  if (input.draft.expiresAt && input.draft.expiresAt.getTime() < now.getTime()) return { route: "BLOCK", reason: "черновик просрочен" };
  if (["PUBLISHED", "PUBLISHING", "REJECTED", "EXPIRED"].includes(input.draft.status)) return { route: "BLOCK", reason: `статус ${input.draft.status}` };
  if (input.manual) return { route: "PUBLISH", reason: "ручная публикация" };
  if (input.mode !== "AUTO") return { route: "HOLD", reason: `режим ${input.mode}: автоматическая публикация выключена` };
  if (!input.autoPostEnabled) return { route: "HOLD", reason: "AUTO_POST_ENABLED=false" };
  if (input.draft.status === "NEEDS_REVIEW") return { route: "REVIEW", reason: `требует проверки: ${input.draft.reviewReason ?? "валидация"}` };
  if (!["DRAFT", "APPROVED", "SCHEDULED", "PARTIAL"].includes(input.draft.status)) return { route: "HOLD", reason: `статус ${input.draft.status}` };
  const risk = input.draft.riskScore ?? 100;
  const confidence = input.draft.confidence ?? 0;
  const score = input.draft.totalScore ?? 0;
  const problems: string[] = [];
  if (risk >= input.thresholds.maxRisk) problems.push(`риск ${risk} ≥ ${input.thresholds.maxRisk}`);
  if (confidence <= input.thresholds.minConfidence) problems.push(`уверенность ${confidence} ≤ ${input.thresholds.minConfidence}`);
  if (score <= input.thresholds.minScore) problems.push(`балл ${score} ≤ ${input.thresholds.minScore}`);
  if (problems.length) return { route: "REVIEW", reason: `AUTO-порог не пройден: ${problems.join(", ")}` };
  return { route: "PUBLISH", reason: `AUTO: риск ${risk}, уверенность ${confidence}, балл ${score}` };
}
