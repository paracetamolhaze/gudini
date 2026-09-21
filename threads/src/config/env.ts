import { z } from "zod";

/**
 * Process environment, validated once at startup. Secrets (Threads token, LLM keys) live only
 * here: they are never written to the database, logs or API responses.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true" || v === "yes");

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim().replace(/\/+$/, "") : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8600),
  HOST: z.string().default("0.0.0.0"),
  /** URL prefix the service is mounted under (the Gudini site proxies /threads here). */
  THREADS_URL_PREFIX: z
    .string()
    .default("/threads")
    .transform((v) => (v === "/" ? "" : v.replace(/\/+$/, ""))),
  /** Same protection as the Gudini site: empty = open, otherwise cookie gudini_auth or Basic auth. */
  SITE_PASSWORD: z.string().optional().default(""),
  PUBLIC_BASE_URL: optionalUrl,

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  DATA_DIR: z.string().default("./data"),

  THREADS_ACCESS_TOKEN: z.string().optional().default(""),
  THREADS_USER_ID: z.string().optional().default(""),
  THREADS_APP_ID: z.string().optional().default(""),
  THREADS_APP_SECRET: z.string().optional().default(""),
  THREADS_GRAPH_HOST: z.string().default("https://graph.threads.net"),

  /** X API, OAuth 1.0a user context: four strings from the developer portal (app with Read and write). */
  X_API_KEY: z.string().optional().default(""),
  X_API_SECRET: z.string().optional().default(""),
  X_ACCESS_TOKEN: z.string().optional().default(""),
  X_ACCESS_SECRET: z.string().optional().default(""),
  X_API_HOST: z.string().default("https://api.x.com"),

  /** Public wallet address whose Hyperliquid fills become trade cards. Read-only: no private key anywhere. */
  HYPERLIQUID_WALLET: z.string().optional().default(""),
  HYPERLIQUID_API_HOST: z.string().default("https://api.hyperliquid.xyz"),
  COINGECKO_API_KEY: z.string().optional().default(""),

  /** Default provider for every task; per-task models may name another provider (provider:model). */
  LLM_PROVIDER: z.enum(["openrouter", "openai", "anthropic", "gemini", "openai-compatible"]).default("openrouter"),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_BASE_URL: optionalUrl,
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  LLM_MODEL_ANALYSIS: z.string().optional().default(""),
  LLM_MODEL_WRITER: z.string().optional().default(""),
  LLM_MODEL_REPLY: z.string().optional().default(""),
  LLM_MODEL_VISION: z.string().optional().default(""),
  LLM_MODEL_TRANSLATION: z.string().optional().default(""),
  LLM_MODEL_EMBEDDING: z.string().optional().default(""),

  AUTOPILOT_MODE: z.enum(["OFF", "DRAFT", "REVIEW", "AUTO"]).default("DRAFT"),
  DRY_RUN: bool,
  AUTO_POST_ENABLED: bool,
  AUTO_OWN_REPLIES: bool,
  AUTO_PUBLIC_REPLIES: bool,
  IMAGE_TRANSLATION_ENABLED: bool,

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  TIMEZONE: z.string().default("Europe/Moscow"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test helper: replace the cached env. */
export function setEnvForTests(next: Env | null): void {
  cached = next;
}

/** Keys that must never appear in logs or API payloads. */
export const SECRET_ENV_KEYS = [
  "THREADS_ACCESS_TOKEN",
  "THREADS_APP_SECRET",
  "X_API_KEY",
  "X_API_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
  "COINGECKO_API_KEY",
  "LLM_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "SITE_PASSWORD",
  "DATABASE_URL",
  "REDIS_URL",
] as const;
