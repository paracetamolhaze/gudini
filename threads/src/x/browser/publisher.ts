import { PublishUnknownStateError, type AttemptStore } from "../../platforms/attempts.js";
import { splitIntoThreadParts } from "../../shared/threadSplit.js";
import { XBrowserLayoutChanged, XBrowserLoginRequired, XBrowserUnavailable, type XBrowserClient } from "./client.js";

/**
 * Idempotent publishing through the browser. The click that sends a post cannot be taken back, so
 * every retry starts by asking the timeline "is it already there?" — and a timeline we could not
 * read is never treated as an empty one.
 */
export interface XBrowserPublishRequest {
  key: string;
  kind: "post" | "reply" | "quote";
  text: string;
  replyToId?: string;
  quotedId?: string;
  imagePath?: string | null;
}

export interface XBrowserPublishResult {
  id: string;
  permalink: string | null;
  recovered: boolean;
}

/** Nothing left our side yet: the queue may retry this exactly as it was. */
const beforeSend = (err: unknown): boolean => err instanceof XBrowserLoginRequired || err instanceof XBrowserLayoutChanged;

export class XBrowserPublisher {
  constructor(
    private readonly client: XBrowserClient,
    private readonly store: AttemptStore,
  ) {}

  private async send(req: XBrowserPublishRequest) {
    if (req.kind === "reply") return this.client.reply(req.text, req.replyToId!);
    if (req.kind === "quote") return this.client.quote(req.text, req.quotedId!);
    return this.client.publish(req.text, req.imagePath ?? null);
  }

  /** Looked and it is not there (null), or could not look at all (throws). */
  private async probeTimeline(text: string, since: Date): Promise<{ id: string; permalink: string | null } | null> {
    const found = await this.client.recover(text, since);
    return found.id ? { id: found.id, permalink: found.permalink } : null;
  }

  async publish(req: XBrowserPublishRequest): Promise<XBrowserPublishResult> {
    const existing = await this.store.get(req.key);
    if (existing?.status === "PUBLISHED" && existing.postId) return { id: existing.postId, permalink: null, recovered: true };
    if (existing?.status === "FAILED" && /unknown state/i.test(existing.error ?? "")) {
      throw new PublishUnknownStateError(`Публикация ${req.key} в неизвестном состоянии; проверьте аккаунт X перед повтором: ${existing.error}`);
    }
    if (existing) {
      // An earlier attempt may have gone out and its outcome never reached us.
      let recovered: { id: string; permalink: string | null } | null;
      try {
        recovered = await this.probeTimeline(req.text, existing.createdAt);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.store.update(req.key, { status: "UNKNOWN", error: `publish outcome unknown: не удалось прочитать ленту X, повтор отменён: ${reason}` });
        throw err;
      }
      if (recovered) {
        await this.store.update(req.key, { status: "PUBLISHED", postId: recovered.id, error: null });
        return { ...recovered, recovered: true };
      }
    } else {
      const started = await this.store.start(req.key, req.kind);
      if (!started) {
        const again = await this.store.get(req.key);
        if (again?.status === "PUBLISHED" && again.postId) return { id: again.postId, permalink: null, recovered: true };
        throw new Error(`публикация ${req.key} уже выполняется`);
      }
    }

    try {
      const res = await this.send(req);
      if (res.id) {
        await this.store.update(req.key, { status: "PUBLISHED", postId: res.id, error: null });
        return { id: res.id, permalink: res.permalink, recovered: res.probe !== "toast" };
      }
      // Submitted, but X never showed it. Stay UNKNOWN and let the next run probe again: a late
      // post will be found then, and nothing is sent twice in the meantime.
      const why = res.probe === "unreadable" ? "не удалось прочитать ленту после отправки" : "пост не появился в ленте";
      await this.store.update(req.key, { status: "UNKNOWN", error: `publish outcome unknown: ${why}` });
      throw new Error(`X: отправка прошла, подтверждения нет (${why}). Повторим проверку позже.`);
    } catch (err) {
      if (err instanceof PublishUnknownStateError) throw err;
      if (beforeSend(err)) {
        await this.store.update(req.key, { status: "STARTED", error: err instanceof Error ? err.message : "ошибка браузера X" });
        throw err;
      }
      if (err instanceof XBrowserUnavailable) {
        // The container died mid-action; we cannot know which side of the click that was.
        await this.store.update(req.key, { status: "UNKNOWN", error: `publish outcome unknown: ${err.message}` });
        throw err;
      }
      const current = await this.store.get(req.key);
      if (current?.status !== "UNKNOWN") await this.store.update(req.key, { status: "FAILED", error: err instanceof Error ? err.message : "ошибка публикации X" });
      throw err;
    }
  }

  /** Text above the limit goes out as a self-reply thread; each part is resume-safe on its own key. */
  async publishThread(req: XBrowserPublishRequest, maxChars: number): Promise<{ root: XBrowserPublishResult; parts: number }> {
    const parts = req.text.trim().length > maxChars ? splitIntoThreadParts(req.text, maxChars) : [req.text.trim()];
    if (!parts.length) throw new Error("нечего публиковать");
    const root = await this.publish({ ...req, text: parts[0]! });
    let parent = root.id;
    for (let i = 1; i < parts.length; i++) {
      const part = await this.publish({ key: `${req.key}:part${i + 1}`, kind: "reply", text: parts[i]!, replyToId: parent });
      parent = part.id;
    }
    return { root, parts: parts.length };
  }
}
