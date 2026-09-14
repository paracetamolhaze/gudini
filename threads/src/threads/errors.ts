/**
 * Typed errors for every way a Threads Graph API call can fail.
 * Adapted from thenavidm/threads-mcp-cli (MIT) — see THIRD_PARTY_NOTICES.md.
 *
 * Meta returns {"error":{"message","type","code","error_subcode","fbtrace_id"}}; `code` and
 * `error_subcode` distinguish "token expired" (190/463) from "no permission" (190/458 or 10/200-299)
 * from "too fast" (4/17/32), all of which arrive as HTTP 400.
 */

export type MetaErrorBody = { code: number; subcode: number; type: string; message: string; traceId: string };

export class ThreadsError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly code: number;
  readonly subcode: number;
  readonly metaType: string;
  readonly detail: string;
  readonly traceId: string;

  constructor(
    message: string,
    status: number,
    endpoint: string,
    parts: Partial<{ code: number; subcode: number; type: string; detail: string; traceId: string }> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.endpoint = endpoint;
    this.code = parts.code ?? 0;
    this.subcode = parts.subcode ?? 0;
    this.metaType = parts.type ?? "";
    this.detail = parts.detail ?? "";
    this.traceId = parts.traceId ?? "";
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      type: this.name,
      status: this.status,
      endpoint: this.endpoint,
      ...(this.code ? { code: this.code } : {}),
      ...(this.subcode ? { subcode: this.subcode } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.traceId ? { trace_id: this.traceId } : {}),
    };
  }
}

/** Token expired, revoked or invalid. A refresh may fix 190/463; 190/467 needs a new authorisation. */
export class AuthenticationError extends ThreadsError {}
/** Authenticated, but the app lacks the scope or App Review has not granted it. */
export class PermissionError extends ThreadsError {
  readonly scope: string | undefined;
  constructor(message: string, status: number, endpoint: string, parts: ConstructorParameters<typeof ThreadsError>[3], scope?: string) {
    super(message, status, endpoint, parts);
    this.scope = scope;
  }
}
export class ValidationError extends ThreadsError {}
export class NotFoundError extends ThreadsError {}
export class RateLimitError extends ThreadsError {}
export class ServerError extends ThreadsError {}
export class TimeoutError extends ThreadsError {}
export class ContainerError extends ThreadsError {}
export class NetworkError extends ThreadsError {}

export function parseErrorBody(body: string): MetaErrorBody {
  const empty: MetaErrorBody = { code: 0, subcode: 0, type: "", message: "", traceId: "" };
  const text = body.trim();
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const err = (parsed as Record<string, unknown>).error;
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        return {
          code: typeof e.code === "number" ? e.code : 0,
          subcode: typeof e.error_subcode === "number" ? e.error_subcode : 0,
          type: typeof e.type === "string" ? e.type : "",
          message: typeof e.message === "string" ? e.message.slice(0, 500) : "",
          traceId: typeof e.fbtrace_id === "string" ? e.fbtrace_id : "",
        };
      }
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return { ...empty, message: text.replace(/\s+/g, " ").slice(0, 500) };
}

const OAUTH_CODE = 190;
const SUBCODE_EXPIRED = 463;
const SUBCODE_INVALIDATED = 467;
const SUBCODE_CHANGED_PASSWORD = 460;

export const isRefreshable = (code: number, subcode: number): boolean => code === OAUTH_CODE && subcode === SUBCODE_EXPIRED;
export const isUnrecoverableToken = (code: number, subcode: number): boolean =>
  code === OAUTH_CODE && (subcode === SUBCODE_INVALIDATED || subcode === SUBCODE_CHANGED_PASSWORD);

/** The scope each endpoint needs, so a permission failure can name the fix. */
const SCOPE_FOR: Array<[RegExp, string]> = [
  [/threads_publish|\/threads$/, "threads_content_publish"],
  [/manage_reply|pending_replies/, "threads_manage_replies"],
  [/\/replies|\/conversation/, "threads_read_replies"],
  [/\/mentions/, "threads_manage_mentions"],
  [/insights/, "threads_manage_insights"],
  [/keyword_search/, "threads_keyword_search"],
  [/profile_lookup|profile_posts/, "threads_profile_discovery"],
];

export function scopeFor(endpoint: string): string | undefined {
  for (const [pattern, scope] of SCOPE_FOR) if (pattern.test(endpoint)) return scope;
  return undefined;
}

export function errorFor(status: number, endpoint: string, body: string): ThreadsError {
  const { code, subcode, type, message, traceId } = parseErrorBody(body);
  const parts = { code, subcode, type, detail: message, traceId };

  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
    return new RateLimitError(
      `Threads rate limited ${endpoint} (code ${code || status}). Posting is capped at 250 posts and 1,000 replies per rolling 24 hours; keyword search at 2,200 queries. ${message}`.trim(),
      status,
      endpoint,
      parts,
    );
  }
  if (code === OAUTH_CODE || status === 401) {
    if (isUnrecoverableToken(code, subcode)) {
      return new AuthenticationError(
        `Threads token was invalidated (190/${subcode}) and cannot be refreshed — authorise the app again and set THREADS_ACCESS_TOKEN.`,
        status,
        endpoint,
        parts,
      );
    }
    return new AuthenticationError(
      `Threads rejected the access token for ${endpoint}: ${message || "OAuthException"}. Long-lived tokens last 60 days and must be refreshed before they expire.`,
      status,
      endpoint,
      parts,
    );
  }
  if (status === 403 || code === 10 || (code >= 200 && code <= 299)) {
    const scope = scopeFor(endpoint);
    return new PermissionError(
      scope
        ? `Threads refused ${endpoint}: this endpoint needs the ${scope} permission on the access token (and App Review / Advanced Access for accounts other than app testers). ${message}`.trim()
        : `Threads refused ${endpoint}: missing OAuth scope or App Review permission. ${message}`.trim(),
      status,
      endpoint,
      parts,
      scope,
    );
  }
  if (status === 404 || code === 803 || code === 100 && /does not exist|unsupported get request/i.test(message)) {
    return new NotFoundError(`Not found via ${endpoint}: ${message || "no such object"}`, status, endpoint, parts);
  }
  if (status >= 500) {
    return new ServerError(`Threads returned HTTP ${status} for ${endpoint}: ${message || "upstream error"}`, status, endpoint, parts);
  }
  return new ValidationError(
    `Threads rejected the request to ${endpoint}${code ? ` (code ${code}${subcode ? `/${subcode}` : ""})` : ""}: ${message || `HTTP ${status}`}`,
    status,
    endpoint,
    parts,
  );
}

export function isRetryableThreadsError(err: unknown): boolean {
  if (err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError) return true;
  if (err instanceof ThreadsError) return err.code === 2 || err.code === 1;
  return false;
}
