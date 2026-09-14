import type { Logger } from "pino";
import { delay } from "../shared/ids.js";
import {
  AuthenticationError,
  ContainerError,
  NetworkError,
  ThreadsError,
  TimeoutError,
  errorFor,
  isRefreshable,
  isRetryableThreadsError,
} from "./errors.js";
import {
  MENTION_FIELDS,
  POST_FIELDS,
  REPLY_FIELDS,
  type ContainerStatus,
  type CreateContainerParams,
  type Paged,
  type PostInsights,
  type PublicProfileLookup,
  type PublishingLimit,
  type ThreadsMedia,
  type ThreadsProfile,
} from "./types.js";

/**
 * Threads Graph API client: timeouts, throttling, typed errors, retries of 5xx/timeouts only,
 * proactive + reactive long-lived token refresh, container status polling.
 *
 * Adapted from eisenjimmy/autoTHREADS and thenavidm/threads-mcp-cli (both MIT).
 * This layer knows nothing about prompts, drafts or the database.
 */

export interface ThreadsClientOptions {
  accessToken: string;
  userId?: string;
  graphHost?: string;
  requestTimeoutMs?: number;
  containerTimeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  /** Called after a successful refresh so the new token can be persisted by the owner. */
  onTokenRefreshed?: (token: string, expiresAt: number | undefined) => void;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
}

export interface CallInit {
  method?: "GET" | "POST" | "DELETE";
  params?: Record<string, unknown>;
  noRetry?: boolean;
}

export type ThreadsTokenState = { accessToken: string; expiresAt: number | undefined };

export class ThreadsClient {
  private token: ThreadsTokenState;
  private cachedUserId: string | undefined;
  private profile: ThreadsProfile | null = null;
  private profilePromise: Promise<ThreadsProfile> | null = null;
  private lastRequestAt = 0;
  private readonly host: string;
  private readonly requestTimeoutMs: number;
  private readonly containerTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger | undefined;
  private readonly userAgent: string;
  private readonly onTokenRefreshed: ThreadsClientOptions["onTokenRefreshed"];

  constructor(opts: ThreadsClientOptions) {
    this.token = { accessToken: opts.accessToken, expiresAt: undefined };
    this.cachedUserId = opts.userId && /^\d+$/.test(opts.userId) ? opts.userId : undefined;
    this.host = (opts.graphHost ?? "https://graph.threads.net").replace(/\/+$/, "");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
    this.containerTimeoutMs = opts.containerTimeoutMs ?? 90_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.minIntervalMs = opts.minRequestIntervalMs ?? 250;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger;
    this.userAgent = opts.userAgent ?? "gudini-threads/0.1 (+https://github.com/paracetamolhaze/gudini)";
    this.onTokenRefreshed = opts.onTokenRefreshed;
  }

  get hasToken(): boolean {
    return this.token.accessToken.trim().length > 0;
  }

  setTokenExpiry(expiresAt: number | undefined): void {
    this.token.expiresAt = expiresAt;
  }

  get tokenExpiresAt(): number | undefined {
    return this.token.expiresAt;
  }

  // ---------------------------------------------------------------- transport

  async call<T = unknown>(path: string, init: CallInit = {}): Promise<T> {
    if (!this.hasToken) {
      throw new AuthenticationError("THREADS_ACCESS_TOKEN is not configured", 0, path);
    }
    const method = init.method ?? "GET";
    const attempts = init.noRetry ? 1 : this.maxRetries + 1;
    let lastError: unknown;
    await this.maybeRefresh();
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.throttle();
      try {
        return (await this.raw(path, method, init.params ?? {})) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof ThreadsError && isRefreshable(err.code, err.subcode)) {
          const refreshed = await this.refreshToken().catch(() => false);
          if (refreshed) continue;
        }
        if (!isRetryableThreadsError(err) || attempt === attempts - 1) throw err;
        const backoff = Math.min(8_000, 2 ** attempt * 500) + Math.random() * 250;
        this.log?.warn({ path, attempt, backoff, err: err instanceof Error ? err.message : String(err) }, "threads retry");
        await delay(backoff);
      }
    }
    throw lastError;
  }

  private async throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
  }

  private async raw(path: string, method: "GET" | "POST" | "DELETE", params: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${this.host}/v1.0${path.startsWith("/") ? path : `/${path}`}`);
    const body = new URLSearchParams();
    const all: Record<string, unknown> = { ...params, access_token: this.token.accessToken };
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined || value === null || value === "") continue;
      const encoded = Array.isArray(value) ? value.join(",") : typeof value === "boolean" ? String(value) : String(value);
      if (method === "GET") url.searchParams.set(key, encoded);
      else body.set(key, encoded);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        signal: controller.signal,
        headers: { "user-agent": this.userAgent },
        ...(method === "GET" ? {} : { body }),
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new TimeoutError(`Threads did not answer ${path} within ${this.requestTimeoutMs} ms`, 408, path);
      }
      throw new NetworkError(`Could not reach ${this.host}: ${(err as Error)?.message ?? String(err)}`, 0, path);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw errorFor(res.status, path, text);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  // ---------------------------------------------------------------- tokens

  /** Refresh when the recorded expiry is within 7 days (Meta allows refresh once the token is a day old). */
  private async maybeRefresh(): Promise<void> {
    const exp = this.token.expiresAt;
    if (!exp) return;
    const remaining = exp - Date.now();
    const DAY = 86_400_000;
    if (remaining <= 0 || remaining > 7 * DAY) return;
    if (Date.now() < exp - 59 * DAY) return; // younger than a day
    await this.refreshToken().catch(() => false);
  }

  async refreshToken(): Promise<boolean> {
    const url = new URL(`${this.host}/refresh_access_token`);
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", this.token.accessToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), { signal: controller.signal, headers: { "user-agent": this.userAgent } });
      const text = await res.text();
      if (!res.ok) throw errorFor(res.status, "/refresh_access_token", text);
      const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
      if (!parsed.access_token) return false;
      this.token = {
        accessToken: parsed.access_token,
        expiresAt: typeof parsed.expires_in === "number" ? Date.now() + parsed.expires_in * 1000 : undefined,
      };
      this.onTokenRefreshed?.(this.token.accessToken, this.token.expiresAt);
      this.log?.info({ expiresAt: this.token.expiresAt }, "threads token refreshed");
      return true;
    } catch (err) {
      this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "threads token refresh failed");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exchange a short-lived token for a 60-day one (needs the app secret). */
  static async exchangeForLongLived(shortLived: string, appSecret: string, host = "https://graph.threads.net"): Promise<ThreadsTokenState> {
    const url = new URL(`${host}/access_token`);
    url.searchParams.set("grant_type", "th_exchange_token");
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("access_token", shortLived);
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) throw errorFor(res.status, "/access_token", text);
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new AuthenticationError("/access_token returned no access_token", res.status, "/access_token");
    return {
      accessToken: parsed.access_token,
      expiresAt: typeof parsed.expires_in === "number" ? Date.now() + parsed.expires_in * 1000 : undefined,
    };
  }

  // ---------------------------------------------------------------- identity

  async me(): Promise<ThreadsProfile> {
    if (this.profile) return this.profile;
    if (this.profilePromise) return this.profilePromise;
    this.profilePromise = (async () => {
      const me = await this.call<ThreadsProfile>("/me", {
        params: { fields: "id,username,name,threads_profile_picture_url,threads_biography,is_verified" },
      });
      if (typeof me.id !== "string" || !me.id) throw new ThreadsError("/me returned no id", 0, "/me");
      this.profile = { ...me, username: typeof me.username === "string" ? me.username : "" };
      this.cachedUserId = me.id;
      return this.profile;
    })().finally(() => {
      this.profilePromise = null;
    });
    return this.profilePromise;
  }

  async userId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    return (await this.me()).id;
  }

  // ---------------------------------------------------------------- reading

  async myPosts(opts: { limit?: number; since?: number; until?: number; after?: string } = {}): Promise<Paged<ThreadsMedia>> {
    const uid = await this.userId();
    return this.call<Paged<ThreadsMedia>>(`/${uid}/threads`, {
      params: { fields: POST_FIELDS, limit: Math.min(100, opts.limit ?? 25), since: opts.since, until: opts.until, after: opts.after },
    });
  }

  async getPost(id: string, fields = POST_FIELDS): Promise<ThreadsMedia> {
    return this.call<ThreadsMedia>(`/${id}`, { params: { fields } });
  }

  /** Public posts of another profile (threads_profile_discovery; public profiles with 100+ followers). */
  async profilePosts(username: string, opts: { limit?: number; since?: number; after?: string } = {}): Promise<Paged<ThreadsMedia>> {
    return this.call<Paged<ThreadsMedia>>("/profile_posts", {
      params: {
        username: username.replace(/^@/, ""),
        fields: POST_FIELDS,
        limit: Math.min(100, opts.limit ?? 25),
        since: opts.since,
        after: opts.after,
      },
    });
  }

  async profileLookup(username: string): Promise<PublicProfileLookup> {
    return this.call<PublicProfileLookup>("/profile_lookup", {
      params: {
        username: username.replace(/^@/, ""),
        fields: "username,name,profile_picture_url,biography,follower_count,likes_count,quotes_count,reposts_count,views_count,is_verified",
      },
    });
  }

  async keywordSearch(opts: {
    q: string;
    searchType?: "TOP" | "RECENT";
    searchMode?: "KEYWORD" | "TAG";
    mediaType?: "TEXT" | "IMAGE" | "VIDEO";
    since?: number;
    until?: number;
    limit?: number;
    authorUsername?: string;
    after?: string;
  }): Promise<Paged<ThreadsMedia>> {
    return this.call<Paged<ThreadsMedia>>("/keyword_search", {
      params: {
        q: opts.q,
        search_type: opts.searchType ?? "RECENT",
        search_mode: opts.searchMode,
        media_type: opts.mediaType,
        since: opts.since,
        until: opts.until,
        limit: Math.min(100, opts.limit ?? 25),
        author_username: opts.authorUsername?.replace(/^@/, ""),
        fields: `${POST_FIELDS},is_reply`,
        after: opts.after,
      },
    });
  }

  async conversation(postId: string, opts: { after?: string; limit?: number; reverse?: boolean } = {}): Promise<Paged<ThreadsMedia>> {
    return this.call<Paged<ThreadsMedia>>(`/${postId}/conversation`, {
      params: { fields: REPLY_FIELDS, limit: Math.min(100, opts.limit ?? 100), after: opts.after, reverse: opts.reverse === true ? "true" : undefined },
    });
  }

  async replies(postId: string, opts: { after?: string; limit?: number } = {}): Promise<Paged<ThreadsMedia>> {
    return this.call<Paged<ThreadsMedia>>(`/${postId}/replies`, {
      params: { fields: REPLY_FIELDS, limit: Math.min(100, opts.limit ?? 100), after: opts.after },
    });
  }

  /** Every reply the account has received, across posts (the inbox view). */
  async myReplies(opts: { after?: string; limit?: number; since?: number } = {}): Promise<Paged<ThreadsMedia>> {
    const uid = await this.userId();
    return this.call<Paged<ThreadsMedia>>(`/${uid}/replies`, {
      params: { fields: REPLY_FIELDS, limit: Math.min(100, opts.limit ?? 50), after: opts.after, since: opts.since },
    });
  }

  async mentions(opts: { since?: number; until?: number; after?: string; limit?: number } = {}): Promise<Paged<ThreadsMedia>> {
    const uid = await this.userId();
    return this.call<Paged<ThreadsMedia>>(`/${uid}/mentions`, {
      params: { fields: MENTION_FIELDS, limit: Math.min(100, opts.limit ?? 50), since: opts.since, until: opts.until, after: opts.after },
    });
  }

  async publishingLimit(): Promise<PublishingLimit> {
    const uid = await this.userId();
    const res = await this.call<{ data?: PublishingLimit[] }>(`/${uid}/threads_publishing_limit`, {
      params: { fields: "quota_usage,config,reply_quota_usage,reply_config" },
    });
    const row = res.data?.[0];
    if (!row) throw new ThreadsError("threads_publishing_limit returned no data", 0, "/threads_publishing_limit");
    return row;
  }

  async postInsights(id: string): Promise<PostInsights> {
    const res = await this.call<{ data?: Array<{ name?: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>(
      `/${id}/insights`,
      { params: { metric: "views,likes,replies,reposts,quotes,shares" } },
    );
    const out: PostInsights = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
    for (const row of res.data ?? []) {
      if (!row.name || !(row.name in out)) continue;
      const key = row.name as keyof PostInsights;
      if (typeof row.total_value?.value === "number") out[key] = row.total_value.value;
      else if (Array.isArray(row.values)) out[key] = row.values.reduce((s, v) => s + (typeof v.value === "number" ? v.value : 0), 0);
    }
    return out;
  }

  async userInsights(metrics: string[], opts: { since?: number; until?: number } = {}): Promise<Record<string, number>> {
    const uid = await this.userId();
    const res = await this.call<{ data?: Array<{ name?: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>(
      `/${uid}/threads_insights`,
      { params: { metric: metrics.join(","), since: opts.since, until: opts.until } },
    );
    const out: Record<string, number> = {};
    for (const row of res.data ?? []) {
      if (!row.name) continue;
      if (typeof row.total_value?.value === "number") out[row.name] = row.total_value.value;
      else if (Array.isArray(row.values)) out[row.name] = row.values.reduce((s, v) => s + (typeof v.value === "number" ? v.value : 0), 0);
    }
    return out;
  }

  // ---------------------------------------------------------------- publishing

  async createContainer(params: CreateContainerParams): Promise<string> {
    const uid = await this.userId();
    const created = await this.call<{ id?: string }>(`/${uid}/threads`, {
      method: "POST",
      params: {
        media_type: params.media_type,
        text: params.text,
        image_url: params.image_url,
        video_url: params.video_url,
        alt_text: params.alt_text,
        reply_to_id: params.reply_to_id,
        quote_post_id: params.quote_post_id,
        reply_control: params.reply_control,
        link_attachment: params.link_attachment,
        topic_tag: params.topic_tag,
        is_carousel_item: params.is_carousel_item ? "true" : undefined,
        children: params.children?.length ? params.children.join(",") : undefined,
      },
    });
    if (!created.id) throw new ThreadsError("Threads accepted the container but returned no id", 0, `/${uid}/threads`);
    return String(created.id);
  }

  async containerStatus(containerId: string): Promise<{ status: ContainerStatus; errorMessage?: string }> {
    const res = await this.call<{ status?: string; error_message?: string }>(`/${containerId}`, {
      params: { fields: "status,error_message" },
      noRetry: true,
    });
    return { status: (res.status ?? "IN_PROGRESS") as ContainerStatus, errorMessage: res.error_message };
  }

  /** Poll until the container is FINISHED; text containers are ready almost immediately. */
  async awaitContainer(containerId: string): Promise<void> {
    const deadline = Date.now() + this.containerTimeoutMs;
    let wait = 700;
    while (Date.now() < deadline) {
      const { status, errorMessage } = await this.containerStatus(containerId);
      if (status === "FINISHED" || status === "PUBLISHED") return;
      if (status === "ERROR") {
        throw new ContainerError(
          `Threads could not process container ${containerId}: ${errorMessage ?? "no reason given"}. For media the URL must be public HTTPS with an image/video content type.`,
          0,
          "/container",
          { detail: errorMessage ?? "" },
        );
      }
      if (status === "EXPIRED") throw new ContainerError(`Container ${containerId} expired (unpublished containers live 24 hours)`, 0, "/container");
      await delay(wait);
      wait = Math.min(4_000, Math.round(wait * 1.5));
    }
    throw new ContainerError(`Container ${containerId} was still processing after ${Math.round(this.containerTimeoutMs / 1000)} s`, 0, "/container");
  }

  async publishContainer(containerId: string): Promise<string> {
    const uid = await this.userId();
    const published = await this.call<{ id?: string }>(`/${uid}/threads_publish`, { method: "POST", params: { creation_id: containerId } });
    if (!published.id) throw new ThreadsError(`threads_publish for ${containerId} returned no post id`, 0, `/${uid}/threads_publish`);
    return String(published.id);
  }

  async deletePost(id: string): Promise<boolean> {
    const res = await this.call<unknown>(`/${id}`, { method: "DELETE" });
    if (res === true) return true;
    if (res && typeof res === "object") {
      const r = res as Record<string, unknown>;
      return r.success === true || r.raw === "true";
    }
    return false;
  }
}
