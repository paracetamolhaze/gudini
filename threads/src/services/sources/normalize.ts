import type { ThreadsMedia } from "../../threads/types.js";
import { mediaImageUrls } from "../../threads/types.js";

/** One publication from any source, in the shape the rest of the pipeline understands. */
export interface NormalizedMedia {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
  altText?: string;
}

export interface NormalizedPost {
  platform: "threads" | "rss";
  platformPostId: string;
  authorUsername: string;
  text: string;
  permalink: string | null;
  publishedAt: Date | null;
  media: NormalizedMedia[];
  raw: unknown;
}

export function normalizeThreadsMedia(m: ThreadsMedia): NormalizedPost | null {
  if (typeof m.id !== "string" || !m.id) return null;
  const parts: string[] = [];
  if (typeof m.text === "string" && m.text.trim()) parts.push(m.text.trim());
  // A quote/repost carries the quoted text: the reaction is meaningless without it.
  const quoted = m.quoted_post ?? m.reposted_post;
  if (quoted && typeof quoted.text === "string" && quoted.text.trim()) {
    const who = typeof quoted.username === "string" && quoted.username ? `@${quoted.username}` : "quoted post";
    parts.push(`[${m.reposted_post ? "repost of" : "quoting"} ${who}]: ${quoted.text.trim()}`);
  }
  if (typeof m.link_attachment_url === "string" && m.link_attachment_url) parts.push(m.link_attachment_url);
  const text = parts.join("\n\n").trim();
  const media: NormalizedMedia[] = [];
  const pushImage = (url?: string, altText?: string) => {
    const s = typeof url === "string" ? url.trim() : "";
    if (s && /^https?:\/\//i.test(s) && !media.some((x) => x.url === s)) media.push({ type: "image", url: s, altText });
  };
  if (m.media_type === "IMAGE") pushImage(m.media_url, m.alt_text);
  else if (m.media_type === "VIDEO" && m.thumbnail_url) media.push({ type: "video", url: m.media_url ?? m.thumbnail_url, thumbnailUrl: m.thumbnail_url });
  else if (m.media_type === "CAROUSEL_ALBUM") {
    for (const c of m.children?.data ?? []) {
      if (c.media_type === "IMAGE") pushImage(c.media_url, c.alt_text);
      else if (c.media_type === "VIDEO" && c.thumbnail_url) media.push({ type: "video", url: c.media_url ?? c.thumbnail_url, thumbnailUrl: c.thumbnail_url });
    }
  } else if (media.length === 0) {
    for (const url of mediaImageUrls(m)) pushImage(url);
  }
  if (!text && media.length === 0) return null;
  const ts = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
  return {
    platform: "threads",
    platformPostId: m.id,
    authorUsername: typeof m.username === "string" ? m.username.trim().replace(/^@/, "") : "",
    text,
    permalink: typeof m.permalink === "string" && m.permalink ? m.permalink : null,
    publishedAt: Number.isFinite(ts) ? new Date(ts) : null,
    media,
    raw: m,
  };
}

/** Text with URLs, mentions and decorative characters removed — the basis for hashing and similarity. */
export function canonicalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]\w+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,%$]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
