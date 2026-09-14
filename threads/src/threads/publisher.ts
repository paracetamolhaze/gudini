import type { ThreadsClient } from "./client.js";
import { TimeoutError, NetworkError, ServerError, ContainerError, ThreadsError } from "./errors.js";
import { THREADS_MAX_CHARS, splitIntoThreadParts } from "../shared/threadSplit.js";

/**
 * Idempotent publishing. Every send is keyed; the attempt record survives crashes and timeouts.
 * A retry first asks "did this already happen?" — by attempt status, by container status, and by
 * looking for the text among the account's recent posts — before it creates anything new.
 *
 * Thread parts (1/n) are separate attempts (`${key}:part2`…) so a failure after part 1 resumes
 * at part 2 instead of posting part 1 twice.
 */
export interface AttemptRecord {
  idempotencyKey: string;
  status: "STARTED" | "CONTAINER_CREATED" | "PUBLISHED" | "FAILED" | "UNKNOWN";
  containerId: string | null;
  threadsPostId: string | null;
  error: string | null;
  createdAt: Date;
}

export interface AttemptStore {
  get(key: string): Promise<AttemptRecord | null>;
  /** Insert STARTED; returns false if the key already exists (concurrent worker). */
  start(key: string, kind: string): Promise<boolean>;
  update(key: string, patch: Partial<Pick<AttemptRecord, "status" | "containerId" | "threadsPostId" | "error">>): Promise<void>;
}

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

export class PublishUnknownStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishUnknownStateError";
  }
}

const isTransient = (err: unknown): boolean => err instanceof TimeoutError || err instanceof NetworkError || err instanceof ServerError;

export class ThreadsPublisher {
  constructor(
    private readonly client: ThreadsClient,
    private readonly store: AttemptStore,
    private readonly opts: { recoveryWindowMinutes?: number } = {},
  ) {}

  /** Look for a post with exactly this text among recent posts (created after the attempt started). */
  private async findRecentPost(text: string, since: Date, replyToId?: string): Promise<{ id: string; permalink: string | null } | null> {
    const sinceSec = Math.floor((since.getTime() - 5 * 60_000) / 1000);
    const wanted = text.trim();
    if (replyToId) {
      // Replies do not appear under /threads; scan the reply feed of the account.
      const page = await this.client.myReplies({ limit: 50, since: sinceSec }).catch(() => null);
      for (const m of page?.data ?? []) {
        if ((m.text ?? "").trim() === wanted && m.replied_to?.id === replyToId) return { id: m.id, permalink: m.permalink ?? null };
      }
      return null;
    }
    const page = await this.client.myPosts({ limit: 25, since: sinceSec }).catch(() => null);
    for (const m of page?.data ?? []) {
      if ((m.text ?? "").trim() === wanted) return { id: m.id, permalink: m.permalink ?? null };
    }
    return null;
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
    if (existing?.status === "PUBLISHED" && existing.threadsPostId) {
      return { id: existing.threadsPostId, permalink: await this.permalinkOf(existing.threadsPostId), recovered: true, containerId: existing.containerId };
    }
    if (existing?.status === "FAILED" && /unknown state/i.test(existing.error ?? "")) {
      throw new PublishUnknownStateError(`Attempt ${req.key} is in an unknown state; a human must check Threads before retrying: ${existing.error}`);
    }

    // Recovery: something was sent earlier and we never learned the outcome.
    if (existing && (existing.status === "UNKNOWN" || existing.status === "CONTAINER_CREATED")) {
      const found = await this.findRecentPost(req.text, existing.createdAt, req.replyToId);
      if (found) {
        await this.store.update(req.key, { status: "PUBLISHED", threadsPostId: found.id, error: null });
        return { id: found.id, permalink: found.permalink, recovered: true, containerId: existing.containerId };
      }
      if (existing.containerId) {
        const status = await this.client.containerStatus(existing.containerId).catch(() => null);
        if (status?.status === "PUBLISHED") {
          // Meta says it went out but we cannot see it — stop here rather than risk a duplicate.
          await this.store.update(req.key, { status: "FAILED", error: `unknown state: container ${existing.containerId} reports PUBLISHED but the post was not found in recent posts` });
          throw new PublishUnknownStateError(`Container ${existing.containerId} is PUBLISHED but the post could not be located; check the account before retrying.`);
        }
        if (status?.status === "FINISHED") {
          return this.publishContainer(req, existing.containerId, existing.createdAt);
        }
        // ERROR / EXPIRED / unknown → fall through and create a fresh container.
      }
    } else if (!existing) {
      const started = await this.store.start(req.key, req.kind);
      if (!started) {
        // Another worker holds this key; let its outcome stand.
        const again = await this.store.get(req.key);
        if (again?.status === "PUBLISHED" && again.threadsPostId) return { id: again.threadsPostId, permalink: await this.permalinkOf(again.threadsPostId), recovered: true, containerId: again.containerId };
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
        const found = await this.findRecentPost(req.text, startedAt, req.replyToId);
        if (found) {
          await this.store.update(req.key, { status: "PUBLISHED", threadsPostId: found.id, error: null });
          return { id: found.id, permalink: found.permalink, recovered: true, containerId };
        }
        throw err;
      }
      await this.store.update(req.key, { status: "FAILED", error: (err as Error).message });
      throw err;
    }
    await this.store.update(req.key, { status: "PUBLISHED", threadsPostId: postId, error: null });
    return { id: postId, permalink: await this.permalinkOf(postId), recovered: false, containerId };
  }

  /** Publish text that may exceed the limit as a numbered thread; each part is resume-safe. */
  async publishThread(req: PublishRequest): Promise<{ root: PublishResult; parts: number }> {
    const parts = req.text.trim().length > THREADS_MAX_CHARS ? splitIntoThreadParts(req.text) : [req.text.trim()];
    if (parts.length === 0) throw new ThreadsError("nothing to publish", 0, "(local)");
    const root = await this.publish({ ...req, text: parts[0]! });
    for (let i = 1; i < parts.length; i++) {
      await this.publish({ key: `${req.key}:part${i + 1}`, kind: "reply", text: parts[i]!, replyToId: root.id });
    }
    return { root, parts: parts.length };
  }
}
