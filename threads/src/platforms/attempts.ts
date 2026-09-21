/**
 * Idempotent publishing, shared by every platform. Each send is keyed; the attempt record survives
 * crashes and timeouts, so a retry first asks "did this already happen?" before creating anything.
 */
export interface AttemptRecord {
  idempotencyKey: string;
  status: "STARTED" | "CONTAINER_CREATED" | "PUBLISHED" | "FAILED" | "UNKNOWN";
  /** Threads media container id; unused on X. */
  containerId: string | null;
  postId: string | null;
  error: string | null;
  createdAt: Date;
}

export interface AttemptStore {
  get(key: string): Promise<AttemptRecord | null>;
  /** Insert STARTED; returns false if the key already exists (concurrent worker). */
  start(key: string, kind: string): Promise<boolean>;
  update(key: string, patch: Partial<Pick<AttemptRecord, "status" | "containerId" | "postId" | "error">>): Promise<void>;
}

/** The platform may or may not have published; a human must look before anything is re-sent. */
export class PublishUnknownStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishUnknownStateError";
  }
}
