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
    /**
     * Что делать с картинкой исходной публикации:
     *   original  — взять как есть (модель не нужна, работает всегда);
     *   translate — перерисовать надписи по-русски (нужен провайдер с распознаванием картинок:
     *               локальный мост Claude принимает только текст и такую задачу не выполнит);
     *   off       — посты без картинок.
     */
    mode: z.enum(["off", "original", "translate"]),
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
  /**
   * Housekeeping. Bookkeeping tables grow by thousands of rows a day and nobody reads them after a
   * while; a nightly job drops what is older than this. Insight snapshots follow analytics.snapshotDays.
   */
  retention: z.object({
    jobDays: z.number().int().min(1).max(365),
    auditDays: z.number().int().min(1).max(3650),
    llmCallDays: z.number().int().min(1).max(3650),
  }),
  /**
   * Nightly pg_dump into DATA_DIR/backups. The Postgres volume is the only copy of everything the
   * service knows, and the manual script runs only when somebody remembers it.
   */
  backup: z.object({
    enabled: z.boolean(),
    /** How many dumps stay on the volume; the oldest go after a successful run. */
    keep: z.number().int().min(1).max(365),
    /** Below this much free space the dump is skipped loudly instead of filling the disk. */
    minFreeMb: z.number().int().min(0).max(1_000_000),
  }),
  pricing: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
  /** Where posts go. Threads is driven by its Graph API; X is pay-per-use and forbids cold API replies. */
  platforms: z.object({
    threads: z.object({ enabled: z.boolean(), maxChars: z.number().int().min(100).max(10_000) }),
    x: z.object({
      enabled: z.boolean(),
      /** 280 without Premium; Premium accounts may raise it. */
      maxChars: z.number().int().min(100).max(25_000),
      language: z.enum(["ru", "en"]),
      /**
       * off — do not look at other people's posts at all; manual — draft a reply and let the owner
       * post it by hand; quote — publish a quote post; auto — answer under the post itself, which
       * only the browser transport can do.
       */
      engagementMode: z.enum(["off", "manual", "quote", "auto"]),
      /**
       * How many of other people's posts we may read per day. On the paid API this was a bill; through
       * our own browser it is a politeness limit, because X bans accounts that read like scripts.
       */
      dailyReadBudget: z.number().int().min(0).max(100_000),
      /** A post with a link costs ~13x more on X, so links are stripped unless allowed. */
      allowLinks: z.boolean(),
      engagementQuery: z.string().max(400),
      /** USD per unit; X changes these, the ledger uses whatever is set here. */
      prices: z.object({ postCreate: z.number().min(0), postCreateUrl: z.number().min(0), postCreateSummoned: z.number().min(0), postRead: z.number().min(0), ownedRead: z.number().min(0), userRead: z.number().min(0) }),
    }),
  }),
  /** Everything is written in the first person, as the owner. */
  persona: z.object({
    name: z.string().max(80),
    bio: z.string().max(600),
    tone: z.string().max(600),
    rules: z.string().max(1200),
  }),
  /** Hyperliquid: closed profitable trades become a card + a post. Read-only public data by wallet address. */
  trades: z.object({
    enabled: z.boolean(),
    wallet: z.string().max(64),
    pollMinutes: z.number().int().min(2).max(720),
    lookbackDays: z.number().int().min(1).max(90),
    minPnlUsd: z.number().min(0),
    minRoePct: z.number().min(0),
    /** Both thresholds must pass (true) or either one (false). */
    requireBoth: z.boolean(),
    showUsd: z.boolean(),
    showSize: z.boolean(),
    /** Put the full wallet address and the explorer link on the card, so anyone can check the trade. */
    showWallet: z.boolean(),
    maxPostsPerDay: z.number().int().min(0).max(20),
    /** Publish trade posts without a human look (still subject to mode AUTO, kill switch and validation). */
    autoPublish: z.boolean(),
    handle: z.string().max(60),
  }),
  /** Loud pumps and dumps across the market. */
  movers: z.object({
    enabled: z.boolean(),
    pollMinutes: z.number().int().min(10).max(720),
    topN: z.number().int().min(10).max(250),
    minChange24hPct: z.number().min(1).max(1000),
    minChange1hPct: z.number().min(1).max(1000),
    minVolumeUsd: z.number().min(0),
    maxPostsPerDay: z.number().int().min(0).max(20),
    ignore: z.array(z.string()),
  }),
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
      maxPublicRepliesPerHour: 2,
      maxPublicRepliesPerDay: 6,
      maxOwnRepliesPerHour: 6,
      maxOwnRepliesPerDay: 30,
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
      minimumScore: 80,
      pollMinutes: 30,
    },
    replies: { pollMinutes: 5, lookbackHours: 72, maxUnansweredPerPost: 20, minConfidence: 85 },
    images: { mode: "original", retries: 1, minFontPx: 14, maxImagesPerPost: 4 },
    expiry: { breakingHours: 24, normalHours: 72, evergreenHours: 24 * 14 },
    writer: { variantsPerDraft: 2, maxStyleExamples: 6, language: "ru" },
    analytics: { insightsPollMinutes: 180, snapshotDays: 14 },
    retention: { jobDays: 14, auditDays: 90, llmCallDays: 180 },
    backup: { enabled: true, keep: 14, minFreeMb: 512 },
    pricing: DEFAULT_PRICING,
    platforms: {
      threads: { enabled: true, maxChars: 500 },
      x: {
        enabled: true,
        maxChars: 280,
        language: "ru",
        engagementMode: "manual",
        dailyReadBudget: 60,
        allowLinks: false,
        engagementQuery: "(bitcoin OR btc OR ethereum OR solana OR hyperliquid OR крипта OR биткоин) -is:retweet -is:reply",
        prices: { postCreate: 0.015, postCreateUrl: 0.2, postCreateSummoned: 0.01, postRead: 0.005, ownedRead: 0.001, userRead: 0.01 },
      },
    },
    persona: {
      name: "",
      bio: "Частный крипто-трейдер. Торгую перпы на Hyperliquid, слежу за рынком и новостями.",
      tone: "Живой разговорный русский, коротко и по делу, с самоиронией. Без канцелярита, без пафоса и без менторства.",
      rules: "",
    },
    trades: {
      enabled: true,
      wallet: e.HYPERLIQUID_WALLET,
      pollMinutes: 10,
      lookbackDays: 14,
      minPnlUsd: 50,
      minRoePct: 5,
      requireBoth: false,
      showUsd: true,
      showSize: true,
      showWallet: true,
      maxPostsPerDay: 3,
      autoPublish: false,
      handle: "",
    },
    movers: {
      enabled: true,
      pollMinutes: 30,
      topN: 150,
      minChange24hPct: 15,
      minChange1hPct: 8,
      minVolumeUsd: 20_000_000,
      maxPostsPerDay: 2,
      ignore: ["USDT", "USDC", "DAI", "USDE", "FDUSD", "USDS", "PYUSD", "TUSD", "WBTC", "WETH", "STETH", "WSTETH", "WEETH", "WBETH"],
    },
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
