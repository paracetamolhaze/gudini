import { env } from "../../config/env.js";

/**
 * Thin HTTP client for the X browser container. The container is the only thing that touches x.com;
 * everything here is a typed request with a clear failure kind, so callers can tell "log in again"
 * apart from "X changed its markup" apart from "we simply do not know what happened".
 */
export class XBrowserUnavailable extends Error {}
export class XBrowserLoginRequired extends Error {}
export class XBrowserLayoutChanged extends Error {}

export interface XBrowserStatus {
  connected: boolean;
  username: string | null;
  checkedAt: string | null;
  issue: string | null;
  login: boolean;
  busy: boolean;
  error: string;
}

export interface XBrowserPost {
  id: string;
  username: string;
  text: string;
  timestamp: string | null;
  permalink: string;
  isReply: boolean;
  imageUrls: string[];
}

/**
 * What the container saw after clicking. `probe` is the difference between "it is not there" and
 * "we could not look": only the first one may ever lead to sending the same text again.
 */
export interface XBrowserSendResult {
  id: string | null;
  permalink: string | null;
  submitted: boolean;
  probe: "toast" | "found" | "absent" | "unreadable";
}

const TIMEOUT_MS = Number(process.env.X_BROWSER_TIMEOUT_MS || 180_000);

export class XBrowserClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configuredUrl(): boolean {
    return Boolean(this.baseUrl);
  }

  async call<T>(action: string, body: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
    if (!this.baseUrl) throw new XBrowserUnavailable("Адрес браузера X не задан (X_BROWSER_URL).");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new XBrowserUnavailable(`Браузер X не отвечает: ${err instanceof Error ? err.message : "нет связи"}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (res.ok) return parsed as T;
    const payload = parsed as { error?: string; kind?: string };
    const message = payload.error || `Браузер X вернул ${res.status}`;
    if (res.status === 409 || payload.kind === "login") throw new XBrowserLoginRequired(message);
    if (payload.kind === "layout") throw new XBrowserLayoutChanged(message);
    throw new Error(message);
  }

  status(): Promise<XBrowserStatus> {
    return this.call<XBrowserStatus>("status", {}, 15_000);
  }

  me(): Promise<{ username: string }> {
    return this.call<{ username: string }>("me", {}, 90_000);
  }

  publish(text: string, imagePath: string | null): Promise<XBrowserSendResult> {
    return this.call<XBrowserSendResult>("publish", { text, imagePath });
  }

  reply(text: string, replyToId: string): Promise<XBrowserSendResult> {
    return this.call<XBrowserSendResult>("reply", { text, replyToId });
  }

  quote(text: string, quotedId: string): Promise<XBrowserSendResult> {
    return this.call<XBrowserSendResult>("quote", { text, quotedId });
  }

  recover(text: string, since: Date): Promise<{ id: string | null; permalink: string | null }> {
    return this.call("recover", { text, since: since.toISOString() });
  }

  inbox(max: number): Promise<{ posts: XBrowserPost[] }> {
    return this.call("inbox", { max });
  }

  search(query: string, max: number): Promise<{ posts: XBrowserPost[] }> {
    return this.call("search", { query, max });
  }

  thread(postId: string, max: number): Promise<{ posts: XBrowserPost[] }> {
    return this.call("thread", { postId, max });
  }

  metrics(postId: string): Promise<{ metrics: Record<string, number> }> {
    return this.call("metrics", { postId }, 90_000);
  }
}

let client: XBrowserClient | null = null;

export function xBrowser(): XBrowserClient {
  if (!client) {
    const e = env();
    client = new XBrowserClient(e.X_BROWSER_URL, e.X_BROWSER_TOKEN);
  }
  return client;
}

export function setXBrowserForTests(next: XBrowserClient | null): void {
  client = next;
}
