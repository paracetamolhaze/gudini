import type { ThreadsClient } from "./client.js";
import { TimeoutError, NetworkError, ServerError, ContainerError, ThreadsError } from "./errors.js";
import { THREADS_MAX_CHARS, splitIntoThreadParts } from "../shared/threadSplit.js";
import { PublishUnknownStateError, type AttemptRecord, type AttemptStore } from "../platforms/attempts.js";

export { PublishUnknownStateError };
export type { AttemptRecord, AttemptStore };

/**
 * Idempotent publishing. Every send is keyed; the attempt record survives crashes and timeouts.
 * A retry first asks "did this already happen?" — by attempt status, by container status, and by
 * looking for the text among the account's recent posts — before it creates anything new.
 *
 * Thread parts (1/n) are separate attempts (`${key}:part2`…) so a failure after part 1 resumes
 * at part 2 instead of posting part 1 twice.
 */
export interface PublishRequest {
  key: string;
  kind: "post" | "reply";
  text: string;
  imageUrl?: string;
  replyToId?: string;
  altText?: string;
}

export interface PublishResult {
  id: string;
  permalink: string | null;
  recovered: boolean;
  containerId: string | null;
}

const isTransient = (err: unknown): boolean => err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError;

/**
 * The outcome of a read that can itself fail. "Read it, the post is not there" and "could not read"
 * must never collapse into one value: the first allows a re-send, the second forbids it.
 */
type Probe<T> = { read: true; value: T } | { read: false; error: unknown };

const unreadable = (error: unknown): Probe<never> => ({ read: false, error });

type ContainerState = Awaited<ReturnType<ThreadsClient["containerStatus"]>>;

export class ThreadsPublisher {
  constructor(
    private readonly client: ThreadsClient,
    private readonly store: AttemptStore,
    private readonly opts: { recoveryWindowMinutes?: number } = {},
  ) {}

  /**
   * Look for a post with exactly this text among recent posts (created after the attempt started).
   * A failed read comes back as `read: false`, never as "no such post".
   */
  private async findRecentPost(text: string, since: Date, replyToId?: string): Promise<Probe<{ id: string; permalink: string | null } | null>> {
    const sinceSec = Math.floor((since.getTime() - 5 * 60_000) / 1000);
    const wanted = text.trim();
    try {
      if (replyToId) {
        // Replies do not appear under /threads; scan the reply feed of the account.
        const page = await this.client.myReplies({ limit: 50, since: sinceSec });
        for (const m of page.data ?? []) {
          if ((m.text ?? "").trim() === wanted && m.replied_to?.id === replyToId) return { read: true, value: { id: m.id, permalink: m.permalink ?? null } };
        }
        return { read: true, value: null };
      }
      const page = await this.client.myPosts({ limit: 25, since: sinceSec });
      for (const m of page.data ?? []) {
        if ((m.text ?? "").trim() === wanted) return { read: true, value: { id: m.id, permalink: m.permalink ?? null } };
      }
      return { read: true, value: null };
    } catch (err) {
      return unreadable(err);
    }
  }

  private async probeContainer(containerId: string): Promise<Probe<ContainerState>> {
    try {
      return { read: true, value: await this.client.containerStatus(containerId) };
    } catch (err) {
      return unreadable(err);
    }
  }

  /**
   * A probe we could not read means the post may already be live. Keep the attempt UNKNOWN and hand
   * the original (usually retryable) error back to the queue: arriving late beats posting twice.
   */
  private async holdUnknown(key: string, what: string, cause: unknown): Promise<Error> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await this.store.update(key, { status: "UNKNOWN", error: `publish outcome unknown: ${what}: ${reason}` });
    return cause instanceof Error ? cause : new ThreadsError(`${what}: ${reason}`, 0, "(local)");
  }

  private async permalinkOf(id: string): Promise<string | null> {
    try {
      const post = await this.client.getPost(id, "id,permalink");
      return post.permalink ?? null;
    } catch {
      return null;
    }
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const existing = await this.store.get(req.key);
    if (existing?.status === "PUBLISHED" && existing.postId) {
      return { id: existing.postId, permalink: await this.permalinkOf(existing.postId), recovered: true, containerId: existing.containerId };
    }
    if (existing?.status === "FAILED" && /unknown state/i.test(existing.error ?? "")) {
      throw new PublishUnknownStateError(`Attempt ${req.key} is in an unknown state; a human must check Threads before retrying: ${existing.error}`);
    }

    // Recovery: something may have been sent earlier and we never learned the outcome. FAILED goes
    // through here too — the call can reach Meta and still come back as an error (an expired
    // container after a retried publish, a timeout turned into a rejection).
    if (existing && (existing.status === "UNKNOWN" || existing.status === "CONTAINER_CREATED" || existing.status === "FAILED")) {
      const recent = await this.findRecentPost(req.text, existing.createdAt, req.replyToId);
      if (recent.read && recent.value) {
        await this.store.update(req.key, { status: "PUBLISHED", postId: recent.value.id, error: null });
        return { id: recent.value.id, permalink: recent.value.permalink, recovered: true, containerId: existing.containerId };
      }
      if (!recent.read) throw await this.holdUnknown(req.key, "не удалось прочитать ленту аккаунта, повторная публикация отменена", recent.error);
      if (existing.containerId) {
        const probe = await this.probeContainer(existing.containerId);
        if (!probe.read) throw await this.holdUnknown(req.key, `не удалось прочитать статус контейнера ${existing.containerId}, повторная публикация отменена`, probe.error);
        if (probe.value.status === "PUBLISHED") {
          // Meta says it went out but we cannot see it — stop here rather than risk a duplicate.
          await this.store.update(req.key, { status: "FAILED", error: `unknown state: container ${existing.containerId} reports PUBLISHED but the post was not found in recent posts` });
          throw new PublishUnknownStateError(`Container ${existing.containerId} is PUBLISHED but the post could not be located; check the account before retrying.`);
        }
        if (probe.value.status === "FINISHED") {
          return this.publishContainer(req, existing.containerId, existing.createdAt);
        }
        // ERROR / EXPIRED / IN_PROGRESS → nothing is public; fall through and create a fresh container.
      }
    } else if (!existing) {
      const started = await this.store.start(req.key, req.kind);
      if (!started) {
        // Another worker holds this key; let its outcome stand.
        const again = await this.store.get(req.key);
        if (again?.status === "PUBLISHED" && again.postId) return { id: again.postId, permalink: await this.permalinkOf(again.postId), recovered: true, containerId: again.containerId };
        throw new ThreadsError(`attempt ${req.key} is already in progress`, 0, "(local)");
      }
    }

    let containerId: string;
    try {
      containerId = await this.client.createContainer({
        media_type: req.imageUrl ? "IMAGE" : "TEXT",
        text: req.text,
        image_url: req.imageUrl,
        alt_text: req.altText,
        reply_to_id: req.replyToId,
      });
    } catch (err) {
      if (isTransient(err)) {
        // The container may or may not exist; nothing is public yet, so a retry is safe.
        await this.store.update(req.key, { status: "STARTED", error: (err as Error).message });
      } else {
        await this.store.update(req.key, { status: "FAILED", error: (err as Error).message });
      }
      throw err;
    }
    await this.store.update(req.key, { status: "CONTAINER_CREATED", containerId, error: null });
    return this.publishContainer(req, containerId, existing?.createdAt ?? new Date());
  }

  private async publishContainer(req: PublishRequest, containerId: string, startedAt: Date): Promise<PublishResult> {
    try {
      await this.client.awaitContainer(containerId);
    } catch (err) {
      if (err instanceof ContainerError) await this.store.update(req.key, { status: "FAILED", error: err.message });
      throw err;
    }
    let postId: string;
    try {
      postId = await this.client.publishContainer(containerId);
    } catch (err) {
      if (isTransient(err)) {
        // The publish call may have gone through. Mark UNKNOWN; the next attempt recovers instead of re-sending.
        await this.store.update(req.key, { status: "UNKNOWN", error: `publish outcome unknown: ${(err as Error).message}` });
        const recent = await this.findRecentPost(req.text, startedAt, req.replyToId);
        if (recent.read && recent.value) {
          await this.store.update(req.key, { status: "PUBLISHED", postId: recent.value.id, error: null });
          return { id: recent.value.id, permalink: recent.value.permalink, recovered: true, containerId };
        }
        // Found nothing, or could not look: either way the attempt stays UNKNOWN for the next round.
        throw err;
      }
      await this.store.update(req.key, { status: "FAILED", error: (err as Error).message });
      throw err;
    }
    await this.store.update(req.key, { status: "PUBLISHED", postId: postId, error: null });
    return { id: postId, permalink: await this.permalinkOf(postId), recovered: false, containerId };
  }

  /** Publish text that may exceed the limit as a numbered thread; each part is resume-safe. */
  async publishThread(req: PublishRequest, maxChars: number = THREADS_MAX_CHARS): Promise<{ root: PublishResult; parts: number }> {
    const parts = req.text.trim().length > maxChars ? splitIntoThreadParts(req.text, maxChars) : [req.text.trim()];
    if (parts.length === 0) throw new ThreadsError("nothing to publish", 0, "(local)");
    const root = await this.publish({ ...req, text: parts[0]! });
    for (let i = 1; i < parts.length; i++) {
      await this.publish({ key: `${req.key}:part${i + 1}`, kind: "reply", text: parts[i]!, replyToId: root.id });
    }
    return { root, parts: parts.length };
  }
}
