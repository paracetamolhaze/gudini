import { readFile } from "node:fs/promises";
import { NetworkError, ServerError, ThreadsError, TimeoutError } from "../threads/errors.js";
import { PublishUnknownStateError, type AttemptStore } from "../platforms/attempts.js";
import { splitIntoThreadParts } from "../shared/threadSplit.js";
import { XDuplicateContentError, type XClient, type XPost } from "./client.js";

/**
 * Idempotent publishing to X. POST /2/tweets is never blindly retried: after a timeout the post may
 * exist, so the next attempt first looks for the exact text among the account's recent posts (a
 * cheap "owned read"). X's own duplicate-content rejection is treated as "it is already out".
 */
export interface XPublishRequest {
  key: string;
  kind: "post" | "reply" | "quote";
  text: string;
  replyToId?: string;
  quotedId?: string;
  imagePath?: string | null;
  /** Reply to someone who mentioned us (billed at the cheaper "summoned" rate). */
  summoned?: boolean;
}

export interface XPublishResult {
  id: string;
  permalink: string | null;
  recovered: boolean;
}

const isTransient = (err: unknown): boolean => err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError;

/** A read that can itself fail: "nothing found" and "could not look" are different answers. */
type Probe<T> = { read: true; value: T } | { read: false; error: unknown };

const mimeFor = (file: string): string => (/\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg");

export class XPublisher {
  constructor(
    private readonly client: XClient,
    private readonly store: AttemptStore,
  ) {}

  private async permalink(id: string): Promise<string | null> {
    try {
      const me = await this.client.me();
      return `https://x.com/${me.username}/status/${id}`;
    } catch {
      return `https://x.com/i/status/${id}`;
    }
  }

  /**
   * X normalises whitespace a little; compare on collapsed text. A timeline we could not read comes
   * back as `read: false` — never as "the post is not there", which would license a second send.
   */
  private async findRecent(text: string, since: Date, replyToId?: string): Promise<Probe<string | null>> {
    const wanted = text.replace(/\s+/g, " ").trim();
    let posts: XPost[];
    try {
      posts = await this.client.myRecentPosts({ max: 30, startTime: new Date(since.getTime() - 5 * 60_000) });
    } catch (err) {
      return { read: false, error: err };
    }
    for (const p of posts) {
      if (p.text.replace(/\s+/g, " ").trim() !== wanted && !p.text.replace(/\s+/g, " ").trim().startsWith(wanted.slice(0, 200))) continue;
      if (replyToId && !p.referenced_tweets?.some((r) => r.type === "replied_to" && r.id === replyToId)) continue;
      return { read: true, value: p.id };
    }
    return { read: true, value: null };
  }

  /**
   * The timeline was unreadable, so the earlier send may be live. Keep the attempt UNKNOWN and give
   * the queue back the original (usually retryable) error instead of posting again.
   */
  private async holdUnknown(key: string, cause: unknown): Promise<Error> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await this.store.update(key, { status: "UNKNOWN", error: `publish outcome unknown: не удалось прочитать ленту X, повторная публикация отменена: ${reason}` });
    return cause instanceof Error ? cause : new ThreadsError(reason, 0, "(local)");
  }

  async publish(req: XPublishRequest): Promise<XPublishResult> {
    const existing = await this.store.get(req.key);
    if (existing?.status === "PUBLISHED" && existing.postId) return { id: existing.postId, permalink: await this.permalink(existing.postId), recovered: true };
    if (existing?.status === "FAILED" && /unknown state/i.test(existing.error ?? "")) {
      throw new PublishUnknownStateError(`Attempt ${req.key} is in an unknown state; check the X account before retrying: ${existing.error}`);
    }
    if (existing) {
      // Something was sent earlier and the outcome never reached us.
      const recent = await this.findRecent(req.text, existing.createdAt, req.replyToId);
      if (recent.read && recent.value) {
        await this.store.update(req.key, { status: "PUBLISHED", postId: recent.value, error: null });
        return { id: recent.value, permalink: await this.permalink(recent.value), recovered: true };
      }
      if (!recent.read) throw await this.holdUnknown(req.key, recent.error);
    } else {
      const started = await this.store.start(req.key, req.kind);
      if (!started) {
        const again = await this.store.get(req.key);
        if (again?.status === "PUBLISHED" && again.postId) return { id: again.postId, permalink: await this.permalink(again.postId), recovered: true };
        throw new ThreadsError(`attempt ${req.key} is already in progress`, 0, "(local)");
      }
    }
    const startedAt = existing?.createdAt ?? new Date();

    let mediaIds: string[] | undefined;
    if (req.imagePath) {
      try {
        mediaIds = [await this.client.uploadImage(await readFile(req.imagePath), mimeFor(req.imagePath))];
      } catch (err) {
        // Nothing public happened yet: transient → retry later, anything else → a clear failure.
        await this.store.update(req.key, { status: isTransient(err) ? "STARTED" : "FAILED", error: `media upload: ${(err as Error).message}` });
        throw err;
      }
    }

    try {
      const created = await this.client.createPost({ text: req.text, replyToId: req.replyToId, quotedId: req.quotedId, mediaIds, summoned: req.summoned });
      await this.store.update(req.key, { status: "PUBLISHED", postId: created.id, error: null });
      return { id: created.id, permalink: await this.permalink(created.id), recovered: false };
    } catch (err) {
      if (isTransient(err) || err instanceof XDuplicateContentError) {
        await this.store.update(req.key, { status: "UNKNOWN", error: `publish outcome unknown: ${(err as Error).message}` });
        const recent = await this.findRecent(req.text, startedAt, req.replyToId);
        if (recent.read && recent.value) {
          await this.store.update(req.key, { status: "PUBLISHED", postId: recent.value, error: null });
          return { id: recent.value, permalink: await this.permalink(recent.value), recovered: true };
        }
        // Could not look: leave the attempt UNKNOWN (not "needs a human") and let the queue retry.
        if (!recent.read) throw err;
        if (err instanceof XDuplicateContentError) {
          await this.store.update(req.key, { status: "FAILED", error: `unknown state: X rejected the text as a duplicate, but the post was not found among recent posts` });
          throw new PublishUnknownStateError("X отклонил текст как дубликат, но сам пост не найден; проверьте аккаунт перед повтором.");
        }
        throw err;
      }
      await this.store.update(req.key, { status: "FAILED", error: (err as Error).message });
      throw err;
    }
  }

  /** Text above the limit goes out as a self-reply thread; each part is resume-safe. */
  async publishThread(req: XPublishRequest, maxChars: number): Promise<{ root: XPublishResult; parts: number }> {
    const parts = req.text.trim().length > maxChars ? splitIntoThreadParts(req.text, maxChars) : [req.text.trim()];
    if (parts.length === 0) throw new ThreadsError("nothing to publish", 0, "(local)");
    const root = await this.publish({ ...req, text: parts[0]! });
    let parent = root.id;
    for (let i = 1; i < parts.length; i++) {
      const part = await this.publish({ key: `${req.key}:part${i + 1}`, kind: "reply", text: parts[i]!, replyToId: parent });
      parent = part.id;
    }
    return { root, parts: parts.length };
  }
}
