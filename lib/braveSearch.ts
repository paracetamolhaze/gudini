import { addCost } from "./pipelineCost";
import { recordRequest, assertBudget } from "./costLedger";
import { assertProvider } from "./providerPolicy";

/**
 * Единая точка доступа к Brave Search. Раньше веб-поиск использовался как
 * универсальный инструмент для всего — отсюда случайные страницы вместо медиа.
 * Теперь эндпоинты применяются по назначению: новости устанавливают событие,
 * видео ищет реальные съёмки, картинки — конкретные кадры.
 */

const UA = { "User-Agent": "Gudini/1.0 (short-video editor)", Accept: "application/json" };
const key = () => process.env.BRAVE_API_KEY || process.env.BRAVE || "";

export const braveAvailable = () => Boolean(key());

export type BraveResult = {
  title: string;
  url: string;
  description?: string;
  age?: string;
};

export type BraveVideo = BraveResult & {
  /** прямая ссылка на файл, если провайдер её отдал */
  directUrl?: string;
  thumbnail?: string;
  durationSec?: number;
  publisher?: string;
};

export type BraveImage = BraveResult & {
  imageUrl: string;
  thumbnail?: string;
};

async function call(endpoint: string, params: Record<string, string>): Promise<any | null> {
  // Brave обслуживает только поиск. Проверяем ДО обращения к сети: запрещённая
  // пара не должна успеть потратить запрос, а потом обнаружиться в учёте.
  assertProvider("Media Research", "brave");
  assertBudget("Media Research");
  const token = key();
  if (!token) return null;
  try {
    const url = new URL(`https://api.search.brave.com/res/v1/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { ...UA, "X-Subscription-Token": token } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parseDuration(text?: string): number | undefined {
  if (!text) return undefined;
  const parts = String(text).split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Новости: устанавливают конкретное событие, дату и первоисточники. */
export async function braveNews(query: string): Promise<BraveResult[]> {
  const json = await call("news/search", { q: query, count: "12" });
  addCost({ braveNewsRequests: 1 });
  recordRequest({ stage: "Media Research", provider: "brave", endpoint: "brave/news/search" });
  return (json?.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      title: String(r.title ?? ""),
      url: String(r.url),
      description: String(r.description ?? ""),
      age: r.page_age ?? r.age,
    }));
}

/** Видео: главный канал для короткого монтажа. */
export async function braveVideos(query: string): Promise<BraveVideo[]> {
  const json = await call("videos/search", { q: query, count: "20" });
  addCost({ braveVideoRequests: 1 });
  recordRequest({ stage: "Media Research", provider: "brave", endpoint: "brave/videos/search" });
  return (json?.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      title: String(r.title ?? ""),
      url: String(r.url),
      description: String(r.description ?? ""),
      age: r.age,
      directUrl: r.properties?.url && /\.(mp4|webm|mov)(\?|$)/i.test(r.properties.url) ? r.properties.url : undefined,
      thumbnail: r.thumbnail?.src,
      durationSec: parseDuration(r.video?.duration),
      publisher: r.video?.publisher ?? r.meta_url?.hostname,
    }));
}

/** Изображения: конкретные кадры человека или события. */
export async function braveImages(query: string): Promise<BraveImage[]> {
  const json = await call("images/search", { q: query, count: "15" });
  addCost({ braveImageRequests: 1 });
  recordRequest({ stage: "Media Research", provider: "brave", endpoint: "brave/images/search" });
  return (json?.results ?? [])
    .filter((r: any) => r.properties?.url)
    .map((r: any) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? r.properties.url),
      imageUrl: String(r.properties.url),
      thumbnail: r.thumbnail?.src,
      description: String(r.source ?? ""),
    }));
}

/** Веб: только дополнительный контекст, не основной канал медиа. */
export async function braveWeb(query: string): Promise<BraveResult[]> {
  const json = await call("web/search", { q: query, count: "10" });
  addCost({ braveWebRequests: 1 });
  recordRequest({ stage: "Media Research", provider: "brave", endpoint: "brave/web/search" });
  return (json?.web?.results ?? [])
    .filter((r: any) => r.url)
    .map((r: any) => ({
      title: String(r.title ?? ""),
      url: String(r.url),
      description: String(r.description ?? ""),
      age: r.page_age ?? r.age,
    }));
}
