import type { NormalizedPost } from "./normalize.js";

/**
 * RSS/Atom feed reader. Regex-based parser adapted from eisenjimmy/autoTHREADS news.ts (MIT):
 * feeds are small and well-formed enough that a full XML parser buys nothing here.
 */
const UA = "gudini-threads/0.1 (+https://gudinijr.duckdns.org) RSS reader";
const MAX_ITEMS = 40;

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i"));
  return m ? decodeEntities(m[1]!.trim()) : "";
}

function attrText(block: string, attr: string): string {
  const m = block.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
  return m ? decodeEntities(m[1]!.trim()) : "";
}

export function normalizeStoryUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^source$/i.test(k)) u.searchParams.delete(k);
    if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  publishedAt: Date | null;
  author: string;
  imageUrl: string | null;
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const push = (title: string, link: string, summary: string, published: string, author: string, image: string) => {
    const cleanTitle = stripTags(title);
    const cleanLink = normalizeStoryUrl(stripTags(link));
    if (!cleanTitle || !/^https?:\/\//i.test(cleanLink) || seen.has(cleanLink)) return;
    seen.add(cleanLink);
    const ts = published ? Date.parse(stripTags(published)) : NaN;
    items.push({
      title: cleanTitle,
      link: cleanLink,
      summary: stripTags(summary).slice(0, 2000),
      publishedAt: Number.isFinite(ts) ? new Date(ts) : null,
      author: stripTags(author),
      imageUrl: image && /^https?:\/\//i.test(image) ? image : null,
    });
  };
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < MAX_ITEMS) {
    const b = m[1]!;
    const enclosure = b.match(/<enclosure\b[^>]*>/i)?.[0] ?? "";
    const mediaContent = b.match(/<media:content\b[^>]*>/i)?.[0] ?? b.match(/<media:thumbnail\b[^>]*>/i)?.[0] ?? "";
    const image = /image\//i.test(attrText(enclosure, "type")) ? attrText(enclosure, "url") : attrText(mediaContent, "url");
    push(tagText(b, "title"), tagText(b, "link") || attrText(b.match(/<link\b[^>]*>/i)?.[0] ?? "", "href"), tagText(b, "description") || tagText(b, "content:encoded"), tagText(b, "pubDate") || tagText(b, "dc:date"), tagText(b, "dc:creator") || tagText(b, "author"), image);
  }
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((m = entryRe.exec(xml)) !== null && items.length < MAX_ITEMS) {
    const b = m[1]!;
    const linkTag = b.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/i)?.[0] ?? b.match(/<link\b[^>]*>/i)?.[0] ?? "";
    push(tagText(b, "title"), attrText(linkTag, "href") || tagText(b, "link"), tagText(b, "summary") || tagText(b, "content"), tagText(b, "published") || tagText(b, "updated"), tagText(b, "name"), attrText(b.match(/<media:thumbnail\b[^>]*>/i)?.[0] ?? "", "url"));
  }
  return items;
}

export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 12_000): Promise<FeedItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml);
    if (items.length === 0 && !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("response is not an RSS/Atom feed");
    return items;
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`feed timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function feedItemToPost(item: FeedItem, feedName: string): NormalizedPost {
  const host = (() => {
    try {
      return new URL(item.link).hostname.replace(/^www\./, "");
    } catch {
      return feedName;
    }
  })();
  const text = item.summary && !item.summary.startsWith(item.title) ? `${item.title}\n\n${item.summary}` : item.title;
  return {
    platform: "rss",
    platformPostId: item.link,
    authorUsername: item.author || host,
    text: `${text}\n\n${item.link}`,
    permalink: item.link,
    publishedAt: item.publishedAt,
    media: item.imageUrl ? [{ type: "image", url: item.imageUrl }] : [],
    raw: item,
  };
}
