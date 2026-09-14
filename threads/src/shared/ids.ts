import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

export const nowIso = (): string => new Date().toISOString();

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function snippet(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
