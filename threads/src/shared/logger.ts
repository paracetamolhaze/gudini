import pino, { type Logger } from "pino";

/**
 * Structured JSON logs. Every worker/handler binds requestId/jobId/candidateId/draftId/publicationId
 * through `child()` so a single id can be followed across processes. Secrets are redacted by path.
 */

const REDACT_PATHS = [
  "access_token",
  "accessToken",
  "apiKey",
  "api_key",
  "authorization",
  "headers.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.access_token",
  "*.apiKey",
];

let root: Logger | null = null;

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "gudini-threads" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}

export function logger(): Logger {
  if (!root) {
    const level = process.env.LOG_LEVEL || "info";
    root = createLogger(level, process.env.NODE_ENV !== "production" && process.stdout.isTTY === true);
  }
  return root;
}

export function setLogger(next: Logger): void {
  root = next;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause && typeof (cause as { code: unknown }).code === "string") {
      return `${err.message} (${(cause as { code: string }).code})`;
    }
    return err.message;
  }
  return String(err);
}

/** Strip anything that looks like a bearer token / API key before a string reaches logs or the UI. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|TH[A-Z0-9]{20,}|EAA[A-Za-z0-9]{20,})\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer [redacted]");
}
