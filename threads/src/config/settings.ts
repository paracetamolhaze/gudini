import { z } from "zod";
import { env } from "./env.js";
import { defaultModels } from "../llm/index.js";
import { DEFAULT_PRICING } from "../llm/costs.js";
import { one, query } from "../db/pool.js";

/**
 * Runtime settings: thresholds, limits, models, mode, kill switch. Stored as one JSON document in
 * the `settings` table (key "app") merged over defaults, validated with zod on every read/write.
 * Secrets are NOT settings — they stay in env.
 */

export const MODES = ["OFF", "DRAFT", "REVIEW", "AUTO"] as const;
export type Mode = (typeof MODES)[number];

const hour = z.number().int().min(0).max(23);

export const settingsSchema = z.object({
  mode: z.enum(MODES),
  killSwitch: z.boolean(),
  dryRun: z.boolean(),
  flags: z.object({
    autoPost: z.boolean(),
    autoOwnReplies: z.boolean(),
    autoPublicReplies: z.boolean(),
    imageTranslation: z.boolean(),
  }),
  models: z.object({
    analysis: z.string(),
    writer: z.string(),
    reply: z.string(),
    vision: z.string(),
    translation: z.string(),
    embedding: z.string(),
  }),
  scoring: z.object({
    minimumContentScore: z.number().min(0).max(100),
    weights: z.object({
      relevance: z.number().min(0),
      freshness: z.number().min(0),
      sourcePriority: z.number().min(0),
      novelty: z.number().min(0),
      value: z.number().min(0),
    }),
    autoPublish: z.object({
      maxRisk: z.number().min(0).max(100),
      minConfidence: z.number().min(0).max(100),
      minScore: z.number().min(0).max(100),
    }),
  }),
  dedup: z.object({
    similarityThreshold: z.number().min(0).max(1),
    windowHours: z.number().int().min(1).max(24 * 14),
  }),
  schedule: z.object({
    minimumMinutesBetweenPosts: z.number().int().min(1),
    maximumPostsPerDay: z.number().int().min(0).max(50),
    preferredHours: z.array(hour),
    timezone: z.string(),
  }),
  limits: z.object({
    maxPublicRepliesPerHour: z.number().int().min(0),
    maxPublicRepliesPerDay: z.number().int().min(0),
    maxOwnRepliesPerHour: z.number().int().min(0),
    maxOwnRepliesPerDay: z.number().int().min(0),
    maxPostsPerDay: z.number().int().min(0),
  }),
  sources: z.object({
    defaultPollMinutes: z.number().int().min(2),
    searchPollMinutes: z.number().int().min(5),
    searchKeywords: z.array(z.string()),
    profileFallbackKeywords: z.array(z.string()),
  }),
  engagement: z.object({
    watchKeywords: z.array(z.string()),
    minimumScore: z.number().min(0).max(100),
    pollMinutes: z.number().int().min(5),
  }),
  replies: z.object({
    pollMinutes: z.number().int().min(1),
    lookbackHours: z.number().int().min(1),
    maxUnansweredPerPost: z.number().int().min(1).max(50),
    minConfidence: z.number().min(0).max(100),
  }),
  images: z.object({
    retries: z.number().int().min(0).max(3),
    minFontPx: z.number().int().min(8),
    maxImagesPerPost: z.number().int().min(1).max(10),
  }),
  expiry: z.object({
    breakingHours: z.number().int().min(1),
    normalHours: z.number().int().min(1),
    evergreenHours: z.number().int().min(1),
  }),
  writer: z.object({
    variantsPerDraft: z.number().int().min(1).max(3),
    maxStyleExamples: z.number().int().min(0).max(20),
    language: z.string(),
  }),
  analytics: z.object({
    insightsPollMinutes: z.number().int().min(15),
    snapshotDays: z.number().int().min(1),
  }),
  pricing: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  const e = env();
  return {
    mode: e.AUTOPILOT_MODE,
    killSwitch: false,
    dryRun: e.DRY_RUN,
    flags: {
      autoPost: e.AUTO_POST_ENABLED,
      autoOwnReplies: e.AUTO_OWN_REPLIES,
      autoPublicReplies: e.AUTO_PUBLIC_REPLIES,
      imageTranslation: e.IMAGE_TRANSLATION_ENABLED,
    },
    models: defaultModels(e),
    scoring: {
      minimumContentScore: 65,
      weights: { relevance: 30, freshness: 20, sourcePriority: 15, novelty: 15, value: 20 },
      autoPublish: { maxRisk: 30, minConfidence: 85, minScore: 75 },
    },
    dedup: { similarityThreshold: 0.62, windowHours: 72 },
    schedule: {
      minimumMinutesBetweenPosts: 90,
      maximumPostsPerDay: 6,
      preferredHours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
      timezone: e.TIMEZONE,
    },
    limits: {
      maxPublicRepliesPerHour: 3,
      maxPublicRepliesPerDay: 15,
      maxOwnRepliesPerHour: 10,
      maxOwnRepliesPerDay: 60,
      maxPostsPerDay: 6,
    },
    sources: {
      defaultPollMinutes: 15,
      searchPollMinutes: 30,
      searchKeywords: ["bitcoin ETF", "ethereum", "solana", "stablecoin", "crypto hack"],
      profileFallbackKeywords: ["bitcoin", "btc", "crypto", "ethereum", "eth", "solana", "etf", "stablecoin", "defi", "token"],
    },
    engagement: {
      watchKeywords: ["bitcoin", "btc", "ethereum", "eth", "solana", "crypto", "крипта", "биткоин", "ETF", "stablecoin", "DeFi"],
      minimumScore: 70,
      pollMinutes: 30,
    },
    replies: { pollMinutes: 5, lookbackHours: 72, maxUnansweredPerPost: 20, minConfidence: 70 },
    images: { retries: 1, minFontPx: 14, maxImagesPerPost: 4 },
    expiry: { breakingHours: 24, normalHours: 72, evergreenHours: 24 * 14 },
    writer: { variantsPerDraft: 2, maxStyleExamples: 6, language: "ru" },
    analytics: { insightsPollMinutes: 180, snapshotDays: 14 },
    pricing: DEFAULT_PRICING,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

const KEY = "app";
let cache: { value: Settings; at: number } | null = null;
const CACHE_MS = 5_000;

export async function loadSettings(force = false): Promise<Settings> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await one<{ value: unknown }>("SELECT value FROM settings WHERE key = $1", [KEY]);
  const merged = deepMerge(defaultSettings(), row?.value ?? {});
  const parsed = settingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : defaultSettings();
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(patch: unknown): Promise<Settings> {
  const current = await loadSettings(true);
  const merged = deepMerge(current, patch);
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid settings: ${issues}`);
  }
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(parsed.data)],
  );
  cache = { value: parsed.data, at: Date.now() };
  return parsed.data;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Sync accessor for code paths that already loaded settings this tick (router model source). */
export function cachedSettings(): Settings {
  return cache?.value ?? defaultSettings();
}
