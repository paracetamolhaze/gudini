import { mediaFromPage, searchArchiveOrg, isProtectedPlatform } from "./brollVideo";
/**
 * Публичные источники визуала для фактических перебивок.
 *
 * Порядок замысла: сначала ищем РЕАЛЬНЫЙ кадр события/человека в открытых источниках,
 * и только если его нет — думаем про сток. Generic-сток не должен подменять конкретное
 * событие («скейтер вместо Хендерсона у рекламного щита»).
 *
 * Источники, работающие без ключей:
 *   - Wikimedia Commons (изображения и видео со свободной лицензией);
 *   - Wikipedia (заглавное изображение статьи — лучший способ найти именно этого человека);
 *   - Openverse (агрегатор CC-лицензированных изображений: Flickr, музеи, архивы).
 * Дополнительно подключается веб-поиск, если задан ключ (BRAVE_API_KEY или SERPER_API_KEY).
 *
 * Скачиваем только то, что отдаётся публично штатным HTTP-запросом. Обход DRM, авторизации,
 * paywall и защищённых потоков не реализуется — см. docs/PROJECT-OVERVIEW.md.
 */

export type WebAsset = {
  sourceUrl: string; // страница-источник
  sourceDomain: string;
  directUrl: string; // прямая ссылка на файл
  title?: string;
  license?: string;
  mediaType: "video" | "image";
  entity?: string;
  event?: string;
  retrievalQuery: string;
  retrievedAt: string;
  localPath?: string;
};

const UA = { "User-Agent": "Gudini/1.0 (short-video editor; contact via site)" };
const FREE_LICENSE = /^(cc0|cc by|cc by-sa|public domain|pd|attribution|no restrictions)/i;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Скачивает файл сами: у нас корректный User-Agent, а сторонние сервисы
 * (в том числе vision-модель) с Wikimedia качать не могут — там блокировка.
 */
export async function fetchAsset(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > 8_000 ? buffer : null;
  } catch {
    return null;
  }
}

/** Токены сущности для проверки, что найден именно тот человек/событие. */
function entityTokens(entity?: string): string[] {
  return (entity ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length > 2);
}

/**
 * Подтверждение сущности (§23): имя должно встречаться в названии/описании/контексте.
 * «Football player injury» без упоминания Хендерсона не считается кадром Хендерсона.
 */
export function verifyEntity(asset: WebAsset, entity?: string): boolean {
  const tokens = entityTokens(entity);
  if (!tokens.length) return true;
  const haystack = `${asset.title ?? ""} ${asset.sourceUrl} ${asset.directUrl}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

// ===================== Wikimedia Commons =====================

/** Изображения и видео Commons: свободная лицензия, проверяемая по метаданным. */
export async function searchWikimedia(query: string, wantVideo = false): Promise<WebAsset[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} ${wantVideo ? "filetype:video" : "filetype:bitmap"}`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "12");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|size|mime");
  url.searchParams.set("iiurlwidth", "1600");

  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const json: any = await res.json();
  const out: WebAsset[] = [];
  for (const page of Object.values<any>(json.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const license = String(info.extmetadata?.LicenseShortName?.value ?? "").replace(/<[^>]+>/g, "");
    if (!FREE_LICENSE.test(license)) continue;
    const mime = String(info.mime ?? "");
    const isVideo = mime.startsWith("video/");
    if (wantVideo !== isVideo) continue;
    const direct = isVideo ? info.url : info.thumburl || info.url;
    if (!direct) continue;
    out.push({
      sourceUrl: String(info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${page.title}`),
      sourceDomain: "commons.wikimedia.org",
      directUrl: String(direct),
      title: String(page.title ?? ""),
      license,
      mediaType: isVideo ? "video" : "image",
      retrievalQuery: query,
      retrievedAt: new Date().toISOString(),
    });
  }
  return out;
}

// ===================== Wikipedia =====================

/**
 * Заглавное изображение статьи — самый надёжный способ получить фото ИМЕННО этого человека:
 * статью про Джордана Хендерсона нельзя перепутать с другим футболистом.
 */
export async function searchWikipediaEntity(entity: string): Promise<WebAsset[]> {
  const search = new URL("https://en.wikipedia.org/w/api.php");
  search.searchParams.set("action", "query");
  search.searchParams.set("format", "json");
  search.searchParams.set("list", "search");
  search.searchParams.set("srsearch", entity);
  search.searchParams.set("srlimit", "3");
  const sres = await fetch(search, { headers: UA });
  if (!sres.ok) return [];
  const sjson: any = await sres.json();

  const out: WebAsset[] = [];
  for (const hit of sjson.query?.search ?? []) {
    const title = String(hit.title ?? "");
    const sum = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      { headers: UA },
    );
    if (!sum.ok) continue;
    const json: any = await sum.json();
    const image = json.originalimage?.source ?? json.thumbnail?.source;
    if (!image) continue;
    out.push({
      sourceUrl: json.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${title}`,
      sourceDomain: "en.wikipedia.org",
      directUrl: String(image),
      title,
      license: "Wikipedia lead image (Commons)",
      mediaType: "image",
      entity,
      retrievalQuery: entity,
      retrievedAt: new Date().toISOString(),
    });
  }
  return out;
}

// ===================== Openverse (CC-агрегатор: Flickr, архивы, музеи) =====================

export async function searchOpenverse(query: string): Promise<WebAsset[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license_type", "commercial,modification");
  url.searchParams.set("page_size", "12");
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const json: any = await res.json();
  return (json.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      sourceUrl: String(r.foreign_landing_url ?? r.url),
      sourceDomain: domainOf(String(r.foreign_landing_url ?? r.url)),
      directUrl: String(r.url),
      title: String(r.title ?? ""),
      license: `${r.license ?? ""} ${r.license_version ?? ""}`.trim().toUpperCase(),
      mediaType: "image" as const,
      retrievalQuery: query,
      retrievedAt: new Date().toISOString(),
    }));
}

// ===================== Подключаемый веб-поиск (нужен ключ) =====================

const braveKey = () => process.env.BRAVE_API_KEY || process.env.BRAVE || "";

/** Есть ли ключ поисковика: без него общий веб-поиск не выполняется. */
export function webSearchAvailable(): boolean {
  return Boolean(braveKey() || process.env.SERPER_API_KEY);
}

/**
 * Видео из открытого веба (новостные и спортивные сайты, публичные страницы).
 * Берём ТОЛЬКО прямые файлы, которые отдаются обычным запросом: страницы плееров
 * с защищёнными потоками (YouTube и подобные) сюда не попадают — их поток нельзя
 * получить штатно, а обходить защиту мы не будем.
 */
export async function searchWebVideos(query: string): Promise<WebAsset[]> {
  const key = braveKey();
  if (!key) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/videos/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "20");
    const res = await fetch(url, { headers: { ...UA, Accept: "application/json", "X-Subscription-Token": key } });
    if (!res.ok) return [];
    const json: any = await res.json();
    const out: WebAsset[] = [];
    for (const r of json.results ?? []) {
      const direct = String(r.properties?.url ?? r.url ?? "");
      // только прямые видеофайлы; ссылки на страницы плееров не годятся
      if (!/\.(mp4|webm|mov)(\?|$)/i.test(direct)) continue;
      out.push({
        sourceUrl: String(r.url ?? direct),
        sourceDomain: domainOf(String(r.url ?? direct)),
        directUrl: direct,
        title: String(r.title ?? ""),
        mediaType: "video",
        retrievalQuery: query,
        retrievedAt: new Date().toISOString(),
      });
    }
    return out;
  } catch (e) {
    console.warn("Видео-поиск:", String(e).slice(0, 120));
    return [];
  }
}

/**
 * Поиск изображений по всему открытому вебу (новостные и спортивные сайты,
 * официальные аккаунты). Включается ключом BRAVE_API_KEY или SERPER_API_KEY.
 */
export async function searchWebImages(query: string): Promise<WebAsset[]> {
  const brave = braveKey();
  const serper = process.env.SERPER_API_KEY;
  try {
    if (brave) {
      const url = new URL("https://api.search.brave.com/res/v1/images/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "10");
      const res = await fetch(url, {
        headers: { ...UA, Accept: "application/json", "X-Subscription-Token": brave },
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      return (json.results ?? [])
        .filter((r: any) => r.properties?.url)
        .map((r: any) => ({
          sourceUrl: String(r.url ?? r.properties.url),
          sourceDomain: domainOf(String(r.url ?? r.properties.url)),
          directUrl: String(r.properties.url),
          title: String(r.title ?? ""),
          mediaType: "image" as const,
          retrievalQuery: query,
          retrievedAt: new Date().toISOString(),
        }));
    }
    if (serper) {
      const res = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: { ...UA, "X-API-KEY": serper, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 10 }),
      });
      if (!res.ok) return [];
      const json: any = await res.json();
      return (json.images ?? [])
        .filter((r: any) => r.imageUrl)
        .map((r: any) => ({
          sourceUrl: String(r.link ?? r.imageUrl),
          sourceDomain: domainOf(String(r.link ?? r.imageUrl)),
          directUrl: String(r.imageUrl),
          title: String(r.title ?? ""),
          mediaType: "image" as const,
          retrievalQuery: query,
          retrievedAt: new Date().toISOString(),
        }));
    }
  } catch (e) {
    console.warn("Веб-поиск:", String(e).slice(0, 120));
  }
  return [];
}

/** Обычный веб-поиск: возвращает СТРАНИЦЫ, из которых потом достаём медиа. */
export async function searchWebPages(query: string): Promise<string[]> {
  const key = braveKey();
  if (!key) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    const res = await fetch(url, { headers: { ...UA, Accept: "application/json", "X-Subscription-Token": key } });
    if (!res.ok) return [];
    const json: any = await res.json();
    return (json.web?.results ?? [])
      .map((r: any) => String(r.url ?? ""))
      .filter((u: string) => u && !isProtectedPlatform(u));
  } catch {
    return [];
  }
}

/**
 * Собирает кандидатов по НЕСКОЛЬКИМ запросам из всех доступных источников (§10).
 * Дедуп по прямой ссылке; порядок — приоритет источника.
 */
export async function findWebAssets(
  queries: string[],
  options: { entity?: string; preferVideo?: boolean } = {},
): Promise<WebAsset[]> {
  const seen = new Set<string>();
  const out: WebAsset[] = [];
  const add = (assets: WebAsset[]) => {
    for (const a of assets) {
      if (seen.has(a.directUrl)) continue;
      seen.add(a.directUrl);
      out.push({ ...a, entity: options.entity });
    }
  };

  // портрет сущности из Wikipedia откладываем в конец: для действий нужно видео,
  // а фото человека — надёжный запасной вариант
  let entityFirst: WebAsset[] = [];
  if (options.entity) {
    try {
      entityFirst = await searchWikipediaEntity(options.entity);
    } catch (e) {
      console.warn("Wikipedia:", String(e).slice(0, 100));
    }
  }

  // VIDEO-FIRST: сначала собираем всё видео по всем запросам, потом изображения.
  for (const q of queries.slice(0, 8)) {
    try {
      add(await searchWebVideos(q));
    } catch {}
    try {
      add(await searchWikimedia(q, true));
    } catch {}
    try {
      add(await searchArchiveOrg(q));
    } catch {}
    // страницы из веб-поиска — это точка обнаружения: достаём из них вложенное медиа,
    // а не вставляем скриншот страницы
    try {
      const pages = await searchWebPages(q);
      for (const page of pages.slice(0, 4)) add(await mediaFromPage(page, q));
    } catch {}
  }
  for (const q of queries.slice(0, 8)) {
    try {
      add(await searchWebImages(q));
    } catch {}
    try {
      add(await searchWikimedia(q, false));
    } catch {}
    try {
      add(await searchOpenverse(q));
    } catch {}
  }
  // фото конкретного человека — хороший запасной вариант, но после видео
  if (entityFirst.length) add(entityFirst);
  return out;
}
