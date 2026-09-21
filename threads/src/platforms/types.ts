/**
 * One content pipeline, two outlets. Everything above this layer (writer, publisher, replies,
 * engagement, analytics) talks to a PlatformAdapter and never to a concrete API client, so the
 * rules of each network live in exactly one place.
 */
export const PLATFORM_IDS = ["threads", "x"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const PLATFORM_LABEL: Record<PlatformId, string> = { threads: "Threads", x: "X" };

export function isPlatformId(v: unknown): v is PlatformId {
  return typeof v === "string" && (PLATFORM_IDS as readonly string[]).includes(v);
}

export interface PlatformIdentity {
  id: string;
  username: string;
  name?: string;
}

export interface PlatformImage {
  /** Local file (X uploads bytes itself). */
  path: string | null;
  /** Public HTTPS URL (Threads downloads the image from us). */
  url: string | null;
  altText?: string;
}

export interface PublishPostRequest {
  /** Idempotency key; thread parts derive `${key}:partN` from it. */
  key: string;
  text: string;
  image?: PlatformImage;
}

export interface PublishReplyRequest {
  key: string;
  text: string;
  replyToId: string;
}

export interface PublishQuoteRequest {
  key: string;
  text: string;
  quotedId: string;
}

export interface PublishedPost {
  id: string;
  permalink: string | null;
  parts: number;
  recovered: boolean;
}

export interface InboxItem {
  kind: "reply" | "mention";
  id: string;
  text: string;
  username: string;
  timestamp: Date | null;
  permalink: string | null;
  rootPostId: string | null;
  parentId: string | null;
  imageUrls: string[];
}

export interface ConversationMsg {
  id: string;
  parentId: string | null;
  username: string;
  text: string;
  timestamp: Date | null;
  raw?: unknown;
}

export interface PlatformInbox {
  items: InboxItem[];
  conversations: Map<string, ConversationMsg[]>;
  /** Non-fatal problem worth showing to the owner (missing permission, budget exhausted). */
  notice: string | null;
}

export interface FoundPost {
  id: string;
  username: string;
  text: string;
  publishedAt: Date | null;
  permalink: string | null;
  keyword: string;
}

export interface PostMetrics {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
}

/** How the platform lets us talk under other people's posts. */
export type PublicReplyChannel = "api" | "manual_or_quote";

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly label: string;
  /** Hard text limit of one post on this platform (longer text goes out as a thread). */
  maxChars(): number;
  publicReplyChannel(): PublicReplyChannel;
  /** Credentials are present (says nothing about their validity). */
  configured(): boolean;
  me(): Promise<PlatformIdentity>;
  publishPost(req: PublishPostRequest): Promise<PublishedPost>;
  publishReply(req: PublishReplyRequest): Promise<PublishedPost>;
  /** Quote post; only platforms where quoting is the allowed way into a conversation implement it. */
  publishQuote?(req: PublishQuoteRequest): Promise<PublishedPost>;
  fetchInbox(opts: { ownUsername: string; lookbackHours: number; maxPerPost: number }): Promise<PlatformInbox>;
  searchPosts(opts: { keywords: string[]; lookbackHours: number; perKeyword: number; ownUsername: string }): Promise<{ found: FoundPost[]; error: string | null }>;
  metrics(postId: string): Promise<PostMetrics>;
  /** Link a human can open to answer by hand (used when API replies are not allowed). */
  manualReplyUrl?(postId: string, text: string): string;
}
