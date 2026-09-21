import type { Logger } from "pino";
import { delay } from "../shared/ids.js";
import { AuthenticationError, NetworkError, NotFoundError, PermissionError, RateLimitError, ServerError, ThreadsError, TimeoutError, ValidationError } from "../threads/errors.js";
import { authorizationHeader, type OAuth1Credentials } from "./oauth1.js";

/**
 * X API v2 client, OAuth 1.0a user context. Only the endpoints this service needs: identity,
 * create post (plain / reply / quote / with media), media upload, mentions, recent search, own
 * timeline (publish recovery) and public metrics.
 *
 * X bills per request/resource, so every call reports what it consumed through `onUsage`; the
 * caller keeps the ledger and enforces budgets. Errors reuse the typed classes of the Threads
 * client so pipelines handle both platforms the same way (RateLimitError → queue backoff, …).
 */
export type XUsageKind = "post_create" | "post_create_url" | "post_create_summoned" | "post_read" | "owned_read" | "user_read" | "media_upload";

export interface XClientOptions {
  credentials: OAuth1Credentials;
  apiHost?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  onUsage?: (kind: XUsageKind, units: number, meta?: Record<string, unknown>) => void;
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
}

export interface XPost {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
  public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; bookmark_count?: number };
  /** Filled from `includes.users` by the client. */
  author_username?: string;
}

interface XListResponse {
  data?: XPost[];
  includes?: { users?: XUser[] };
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number; next_token?: string };
}

/** 403 on a reply request: X only accepts API replies to authors who mentioned or quoted the account. */
export class XReplyNotAllowedError extends PermissionError {}
/** X refuses identical text posted twice in a row; for an idempotent publisher that means "already out". */
export class XDuplicateContentError extends ValidationError {}

const POST_FIELDS = "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets";
const URL_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|xyz|co|ru|me|app|fi|gg|ai)\b(?:\/\S*)?/i;

export function containsUrl(text: string): boolean {
  return URL_RE.test(text);
}

export function xErrorFor(status: number, endpoint: string, body: string, opts: { isReply?: boolean } = {}): ThreadsError {
  let detail = body.trim().slice(0, 600);
  let title = "";
  try {
    const parsed = JSON.parse(body) as { detail?: string; title?: string; errors?: Array<{ message?: string; detail?: string }> };
    title = parsed.title ?? "";
    detail = parsed.detail ?? parsed.errors?.map((e) => e.message ?? e.detail ?? "").filter(Boolean).join("; ") ?? detail;
  } catch {
    // keep the raw body
  }
  const message = `X API ${status}${title ? ` ${title}` : ""}: ${detail || "no details"}`;
  const parts = { detail };
  if (status === 401) return new AuthenticationError(`${message}. Проверьте ключи X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET и права приложения Read and write.`, status, endpoint, parts);
  if (status === 402) return new PermissionError(`${message}. Похоже, на балансе X API закончились кредиты.`, status, endpoint, parts, "credits");
  if (status === 403) {
    if (/duplicate/i.test(detail)) return new XDuplicateContentError(message, status, endpoint, parts);
    if (opts.isReply) return new XReplyNotAllowedError(`${message}. X принимает ответы через API только авторам, которые упомянули или процитировали аккаунт.`, status, endpoint, parts, "reply");
    return new PermissionError(message, status, endpoint, parts);
  }
  if (status === 404) return new NotFoundError(message, status, endpoint, parts);
  if (status === 429) return new RateLimitError(message, status, endpoint, parts);
  if (status >= 500) return new ServerError(message, status, endpoint, parts);
  return new ValidationError(message, status, endpoint, parts);
}

const isRetryable = (err: unknown): boolean => err instanceof ServerError || err instanceof TimeoutError || err instanceof NetworkError;

export class XClient {
  private readonly creds: OAuth1Credentials;
  private readonly host: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger | undefined;
  private readonly onUsage: XClientOptions["onUsage"];
  private lastRequestAt = 0;
  private profile: XUser | null = null;
  private profilePromise: Promise<XUser> | null = null;

  constructor(opts: XClientOptions) {
    this.creds = opts.credentials;
    this.host = (opts.apiHost ?? "https://api.x.com").replace(/\/+$/, "");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 25_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.minIntervalMs = opts.minRequestIntervalMs ?? 300;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger;
    this.onUsage = opts.onUsage;
  }

  get hasCredentials(): boolean {
    const c = this.creds;
    return [c.consumerKey, c.consumerSecret, c.accessToken, c.accessSecret].every((v) => v.trim().length > 0);
  }

  // ---------------------------------------------------------------- transport

  private async throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
  }

  private async request<T>(method: "GET" | "POST", path: string, init: { query?: Record<string, string | undefined>; json?: unknown; form?: FormData; noRetry?: boolean; isReply?: boolean } = {}): Promise<T> {
    if (!this.hasCredentials) throw new AuthenticationError("X не подключён: ключи X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET не заданы", 0, path);
    const url = new URL(`${this.host}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const attempts = init.noRetry ? 1 : this.maxRetries + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.throttle();
      try {
        return await this.raw<T>(method, url, init, path);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === attempts - 1) throw err;
        const backoff = Math.min(8_000, 2 ** attempt * 600) + Math.random() * 250;
        this.log?.warn({ path, attempt, backoff, err: err instanceof Error ? err.message : String(err) }, "x retry");
        await delay(backoff);
      }
    }
    throw lastError;
  }

  private async raw<T>(method: "GET" | "POST", url: URL, init: { json?: unknown; form?: FormData; isReply?: boolean }, path: string): Promise<T> {
    const headers: Record<string, string> = { authorization: authorizationHeader(this.creds, { method, url: url.toString() }), "user-agent": "gudini-social/0.2" };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) body = init.form;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, body, signal: controller.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw new TimeoutError(`X did not answer ${path} within ${this.requestTimeoutMs} ms`, 408, path);
      throw new NetworkError(`Could not reach ${this.host}: ${(err as Error)?.message ?? String(err)}`, 0, path);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw xErrorFor(res.status, path, text, { isReply: init.isReply });
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ThreadsError(`X answered ${path} with a non-JSON body`, res.status, path);
    }
  }

  // ---------------------------------------------------------------- identity

  async me(): Promise<XUser> {
    if (this.profile) return this.profile;
    if (this.profilePromise) return this.profilePromise;
    this.profilePromise = (async () => {
      const res = await this.request<{ data?: XUser }>("GET", "/2/users/me", { query: { "user.fields": "username,name" } });
      this.onUsage?.("user_read", 1, { endpoint: "users/me" });
      if (!res.data?.id) throw new ThreadsError("/2/users/me returned no id", 0, "/2/users/me");
      this.profile = res.data;
      return res.data;
    })().finally(() => {
      this.profilePromise = null;
    });
    return this.profilePromise;
  }

  /** Lets the owner of the client pre-seed identity from the database and skip a paid lookup. */
  seedIdentity(user: XUser): void {
    if (!this.profile) this.profile = user;
  }

  // ---------------------------------------------------------------- writing

  async uploadImage(bytes: Buffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.set("media_category", "tweet_image");
    form.set("media", new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType === "image/png" ? "image.png" : "image.jpg");
    const res = await this.request<{ data?: { id?: string } }>("POST", "/2/media/upload", { form, noRetry: true });
    this.onUsage?.("media_upload", 1);
    if (!res.data?.id) throw new ThreadsError("X accepted the media but returned no id", 0, "/2/media/upload");
    return String(res.data.id);
  }

  async createPost(input: { text: string; replyToId?: string; quotedId?: string; mediaIds?: string[]; summoned?: boolean }): Promise<{ id: string }> {
    const json: Record<string, unknown> = { text: input.text };
    if (input.replyToId) json.reply = { in_reply_to_tweet_id: input.replyToId };
    if (input.quotedId) json.quote_tweet_id = input.quotedId;
    if (input.mediaIds?.length) json.media = { media_ids: input.mediaIds };
    // Never retried here: a timeout may mean the post exists. The publisher recovers by looking for it.
    const res = await this.request<{ data?: { id?: string } }>("POST", "/2/tweets", { json, noRetry: true, isReply: Boolean(input.replyToId) });
    this.onUsage?.(containsUrl(input.text) ? "post_create_url" : input.summoned ? "post_create_summoned" : "post_create", 1);
    if (!res.data?.id) throw new ThreadsError("X accepted the post but returned no id", 0, "/2/tweets");
    return { id: String(res.data.id) };
  }

  // ---------------------------------------------------------------- reading

  private withAuthors(res: XListResponse): XPost[] {
    const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u.username]));
    return (res.data ?? []).map((p) => ({ ...p, author_username: p.author_id ? users.get(p.author_id) : undefined }));
  }

  async mentions(opts: { sinceId?: string; startTime?: Date; max?: number } = {}): Promise<{ posts: XPost[]; newestId: string | null }> {
    const me = await this.me();
    const res = await this.request<XListResponse>("GET", `/2/users/${me.id}/mentions`, {
      query: {
        max_results: String(Math.max(5, Math.min(100, opts.max ?? 20))),
        since_id: opts.sinceId,
        start_time: opts.sinceId ? undefined : opts.startTime?.toISOString(),
        "tweet.fields": POST_FIELDS,
        expansions: "author_id",
        "user.fields": "username",
      },
    });
    const posts = this.withAuthors(res);
    if (posts.length) this.onUsage?.("post_read", posts.length, { endpoint: "mentions" });
    return { posts, newestId: res.meta?.newest_id ?? null };
  }

  async searchRecent(opts: { query: string; max?: number; startTime?: Date }): Promise<XPost[]> {
    const res = await this.request<XListResponse>("GET", "/2/tweets/search/recent", {
      query: {
        query: opts.query,
        max_results: String(Math.max(10, Math.min(100, opts.max ?? 10))),
        start_time: opts.startTime?.toISOString(),
        "tweet.fields": POST_FIELDS,
        expansions: "author_id",
        "user.fields": "username",
      },
    });
    const posts = this.withAuthors(res);
    if (posts.length) this.onUsage?.("post_read", posts.length, { endpoint: "search" });
    return posts;
  }

  /** Own recent posts and replies: cheap "owned reads", used to recover an unknown publish outcome. */
  async myRecentPosts(opts: { max?: number; startTime?: Date } = {}): Promise<XPost[]> {
    const me = await this.me();
    const res = await this.request<XListResponse>("GET", `/2/users/${me.id}/tweets`, {
      query: { max_results: String(Math.max(5, Math.min(100, opts.max ?? 20))), start_time: opts.startTime?.toISOString(), exclude: "retweets", "tweet.fields": POST_FIELDS },
    });
    const posts = res.data ?? [];
    if (posts.length) this.onUsage?.("owned_read", posts.length, { endpoint: "users/tweets" });
    return posts;
  }

  async postMetrics(ids: string[]): Promise<Map<string, NonNullable<XPost["public_metrics"]>>> {
    const out = new Map<string, NonNullable<XPost["public_metrics"]>>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.request<XListResponse>("GET", "/2/tweets", { query: { ids: chunk.join(","), "tweet.fields": "public_metrics" } });
      for (const p of res.data ?? []) if (p.public_metrics) out.set(p.id, p.public_metrics);
      if (res.data?.length) this.onUsage?.("owned_read", res.data.length, { endpoint: "tweets" });
    }
    return out;
  }
}
