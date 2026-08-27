import { WebAsset } from "./brollWeb";

/**
 * Видео из открытых источников.
 *
 * Ключевая идея: найденная страница — это ТОЧКА ОБНАРУЖЕНИЯ, а не визуал.
 * Из статьи, поста или новости мы достаём вложенное медиа (og:video, JSON-LD
 * VideoObject, <video>/<source>, og:image), а не вставляем скриншот страницы.
 *
 * Скачиваем только то, что отдаётся обычным HTTP-запросом. Платформы, у которых
 * поток собирается расшифровкой подписи в плеере (YouTube, TikTok, Instagram, X,
 * Facebook), пропускаем: получить их «обычным способом» нельзя, а обходить защиту
 * потока запрещено. Остаются прямые mp4/webm на сайтах, архивы и открытые каталоги.
 */

const UA = { "User-Agent": "Gudini/1.0 (short-video editor)" };

const DIRECT_VIDEO = /\.(mp4|webm|mov|m4v)(\?|$)/i;

/**
 * Домены НЕ блокируются. Проверка идёт по конкретному URL: пробуем забрать медиа
 * обычным HTTP-запросом. Если файл отдаётся штатно (прямой mp4/webm, открытый CDN,
 * плеер новостного сайта, v.redd.it) — используем. Если для получения потока нужен
 * логин, cookies, платная подписка или расшифровка подписи в плеере — пропускаем
 * ЭТОТ ролик и идём к следующему кандидату, а не отключаем платформу целиком.
 */
export function isProtectedPlatform(): boolean {
  return false;
}

/** Ссылка ведёт на файл, который можно скачать обычным запросом. */
export function isDirectMedia(url: string): boolean {
  return DIRECT_VIDEO.test(url);
}

function absolute(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

/**
 * Достаёт из HTML-страницы ссылку на вложенное видео.
 * Порядок: og:video → JSON-LD VideoObject → <video src> / <source src>.
 */
export function extractMediaFromHtml(html: string, pageUrl: string): { video?: string; image?: string } {
  const out: { video?: string; image?: string } = {};

  const meta = (prop: string): string | null => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']|` +
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
      "i",
    );
    const m = html.match(re);
    return m ? (m[1] || m[2] || null) : null;
  };

  for (const prop of ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]) {
    const v = meta(prop);
    const abs = v && absolute(v, pageUrl);
    if (abs && DIRECT_VIDEO.test(abs)) {
      out.video = abs;
      break;
    }
  }

  // JSON-LD VideoObject.contentUrl — так отдают видео многие новостные сайты
  if (!out.video) {
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const found = String(m[1]).match(/"contentUrl"\s*:\s*"([^"]+\.(?:mp4|webm|mov)[^"]*)"/i);
      const abs = found && absolute(found[1].replace(/\\\//g, "/"), pageUrl);
      if (abs) {
        out.video = abs;
        break;
      }
    }
  }

  if (!out.video) {
    for (const m of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) {
      const abs = absolute(m[1], pageUrl);
      if (abs && DIRECT_VIDEO.test(abs)) {
        out.video = abs;
        break;
      }
    }
  }

  // изображение статьи — запасной вариант, но это тоже медиа, а не скриншот страницы
  const img = meta("og:image") ?? meta("twitter:image");
  const absImg = img && absolute(img, pageUrl);
  if (absImg) out.image = absImg;

  return out;
}

/** Открывает страницу-источник и вытаскивает из неё пригодное медиа. */
export async function mediaFromPage(pageUrl: string, query: string): Promise<WebAsset[]> {
  try {
    const res = await fetch(pageUrl, { headers: UA, redirect: "follow" });
    if (!res.ok) return [];
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return [];
    const html = (await res.text()).slice(0, 400_000);
    const media = extractMediaFromHtml(html, pageUrl);
    const title = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1]?.trim();
    const domain = new URL(pageUrl).hostname.replace(/^www\./, "");
    const assets: WebAsset[] = [];
    if (media.video) {
      assets.push({
        sourceUrl: pageUrl,
        sourceDomain: domain,
        directUrl: media.video,
        title,
        mediaType: "video",
        retrievalQuery: query,
        retrievedAt: new Date().toISOString(),
      });
    }
    if (media.image) {
      assets.push({
        sourceUrl: pageUrl,
        sourceDomain: domain,
        directUrl: media.image,
        title,
        mediaType: "image",
        retrievalQuery: query,
        retrievedAt: new Date().toISOString(),
      });
    }
    return assets;
  } catch {
    return [];
  }
}

/**
 * Reddit: публичный JSON-API без ключа и без логина. Видео с v.redd.it отдаётся
 * обычным MP4 по прямой ссылке (DASH-дорожка), поэтому источник полностью пригоден.
 */
export async function searchReddit(query: string): Promise<WebAsset[]> {
  try {
    const url = new URL("https://www.reddit.com/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "15");
    url.searchParams.set("sort", "relevance");
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return [];
    const json: any = await res.json();
    const out: WebAsset[] = [];
    for (const child of json.data?.children ?? []) {
      const d = child.data ?? {};
      const rv = d.secure_media?.reddit_video ?? d.media?.reddit_video ?? d.preview?.reddit_video_preview;
      const fallback = String(rv?.fallback_url ?? "");
      if (!fallback) continue;
      out.push({
        sourceUrl: `https://www.reddit.com${d.permalink ?? ""}`,
        sourceDomain: "reddit.com",
        directUrl: fallback.split("?")[0], // прямая mp4-дорожка без параметров
        title: String(d.title ?? ""),
        mediaType: "video",
        retrievalQuery: query,
        retrievedAt: new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Archive.org — большой открытый каталог видео, скачивается штатно и без ключа.
 * Хорошо закрывает исторические, новостные и общественно-значимые сюжеты.
 */
export async function searchArchiveOrg(query: string): Promise<WebAsset[]> {
  try {
    const url = new URL("https://archive.org/advancedsearch.php");
    url.searchParams.set("q", `${query} AND mediatype:(movies)`);
    url.searchParams.append("fl[]", "identifier");
    url.searchParams.append("fl[]", "title");
    url.searchParams.set("rows", "6");
    url.searchParams.set("output", "json");
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return [];
    const json: any = await res.json();
    const docs: any[] = json.response?.docs ?? [];
    const out: WebAsset[] = [];
    for (const d of docs.slice(0, 4)) {
      const meta = await fetch(`https://archive.org/metadata/${d.identifier}`, { headers: UA });
      if (!meta.ok) continue;
      const m: any = await meta.json();
      const file = (m.files ?? []).find((f: any) => /\.(mp4|webm)$/i.test(f.name ?? "") && Number(f.size ?? 0) < 120_000_000);
      if (!file) continue;
      out.push({
        sourceUrl: `https://archive.org/details/${d.identifier}`,
        sourceDomain: "archive.org",
        directUrl: `https://archive.org/download/${d.identifier}/${encodeURIComponent(file.name)}`,
        title: String(d.title ?? d.identifier),
        license: String(m.metadata?.licenseurl ?? "archive.org"),
        mediaType: "video",
        retrievalQuery: query,
        retrievedAt: new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}
