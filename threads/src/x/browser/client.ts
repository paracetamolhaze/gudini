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

/**
 * How long to wait for the container, per action. One constant cannot fit both ends of the range:
 * `status` answers instantly, while a single publish is a dozen Playwright waits in a row, and a
 * budget that runs out mid-publish is the worst outcome of all — the request dies, the container
 * keeps clicking, and the post may go out after we have already written the attempt off. So the
 * numbers below are added up from the waits in src/x/browser/pages.ts and src/xbrowser.ts; when one
 * of those is changed, the matching term here changes with it.
 */
const NAV = 30_000; // NAV_MS: one navigation around x.com
const LOGGED_IN = 26_000; // assertLoggedIn: 8s look + 10s for the page to paint + 8s look again
const IDENTITY = 90_000; // readIdentity, including the fallback through /settings/account and back
const TIMELINE = 30_000; // waiting for the articles and reading thirty cards off them
const IMAGE = 10_000 + 30_000; // attachImage: the file input, then the blob preview
const BUTTON = 10_000 + 30_000; // submitComposer: finding the button, then waiting for it to go live
const SESSION = NAV + LOGGED_IN + IDENTITY; // ensureSession({ sending: true })
const COMPOSE = NAV + LOGGED_IN + 20_000 + IMAGE + BUTTON; // compose page, text box, image, button
/** After the click: the toast, then the two spaced-out looks at our own timeline. */
const CONFIRM = 18_000 + 5_000 + (NAV + LOGGED_IN + TIMELINE) + 15_000 + (NAV + LOGGED_IN + TIMELINE);
const SEND = SESSION + COMPOSE + CONFIRM;
const READ = SESSION + NAV + LOGGED_IN + TIMELINE;

const BUDGET_MS: Record<string, number> = {
  status: 15_000,
  frame: 30_000,
  input: 30_000,
  close: 30_000,
  disconnect: 60_000,
  login: NAV + 15_000,
  probe: SESSION + 60_000,
  finish: NAV + LOGGED_IN + IDENTITY + 15_000,
  import: NAV + IDENTITY + 30_000,
  me: SESSION + 10_000,
  recover: READ,
  inbox: READ,
  search: READ,
  thread: READ,
  metrics: SESSION + NAV + LOGGED_IN + 20_000,
  publish: SEND,
  reply: SEND,
  quote: SEND,
};

/** An escape hatch for the owner: one number that overrides the whole table without a rebuild. */
const OVERRIDE_MS = Number(process.env.X_BROWSER_TIMEOUT_MS) || 0;
const budget = (action: string): number => OVERRIDE_MS || BUDGET_MS[action] || READ;

export class XBrowserClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configuredUrl(): boolean {
    return Boolean(this.baseUrl);
  }

  async call<T>(action: string, body: Record<string, unknown> = {}, timeoutMs = budget(action)): Promise<T> {
    if (!this.baseUrl) throw new XBrowserUnavailable("Адрес браузера X не задан (X_BROWSER_URL).");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Read the body under the same budget: the answer is not ours until it is fully in hand.
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) throw new XBrowserUnavailable(`Браузер X не ответил за ${Math.round(timeoutMs / 1000)} с (${action}).`);
      throw new XBrowserUnavailable(`Браузер X не отвечает: ${err instanceof Error ? err.message : "нет связи"}`);
    } finally {
      clearTimeout(timer);
    }
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (res.ok) return parsed as T;
    const payload = parsed as { error?: string; kind?: string };
    const message = payload.error || `Браузер X вернул ${res.status}`;
    if (res.status === 409 || payload.kind === "login") throw new XBrowserLoginRequired(message);
    if (payload.kind === "layout") throw new XBrowserLayoutChanged(message);
    throw new Error(message);
  }

  status(): Promise<XBrowserStatus> {
    return this.call<XBrowserStatus>("status");
  }

  me(): Promise<{ username: string }> {
    return this.call<{ username: string }>("me");
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
    return this.call("metrics", { postId });
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
