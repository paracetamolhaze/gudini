import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { braveNews, braveWeb, BraveResult } from "./braveSearch";
import { addCost } from "./pipelineCost";

/**
 * Story Research — первый этап конвейера, которого раньше не существовало.
 *
 * Раньше сценарий писался из одной строки темы «по памяти модели», поэтому у монтажа
 * не было ни события, ни даты, ни участников — и перебивки угадывались по словам.
 * Теперь история сначала исследуется по реальным источникам, и этот пакет живёт
 * вместе с проектом: из него пишется сценарий и из него же строится медиатека.
 */

export type EntityType = "PERSON" | "ORG" | "TEAM" | "PLACE" | "PRODUCT" | "EVENT";
export type SourceType = "OFFICIAL" | "NEWS" | "VIDEO" | "SOCIAL" | "OTHER";

export type StoryEntity = {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
};

export type StoryFact = {
  id: string;
  text: string;
  sourceUrls: string[];
};

export type StorySource = {
  url: string;
  domain: string;
  title?: string;
  publishedAt?: string;
  type: SourceType;
};

export type StoryResearchPack = {
  storyId: string;
  topic: string;
  /** ссылка, которую дал пользователь, — главный источник истины */
  originUrl?: string;
  canonicalEvent: string;
  summary: string;
  eventDate?: string;
  eventYear?: number;
  location?: string;
  /** язык оригинальных источников — для запросов на языке события */
  language?: string;
  entities: StoryEntity[];
  facts: StoryFact[];
  sources: StorySource[];
  createdAt: string;
};

const MODEL = "claude-sonnet-5";

const RESEARCH_SYSTEM = `Ты — ресёрчер новостей для короткого документального видео.
Тебе дают тему (иногда ссылку) и результаты поиска: заголовки, описания и адреса публикаций.

Задача — установить ОДНУ конкретную историю и её факты, опираясь ТОЛЬКО на переданные результаты.
Не добавляй факты из своих знаний: если чего-то нет в источниках, этого нет в пакете.

canonicalEvent — одно предложение на английском, максимально конкретно: кто, что, где, когда.
Это описание потом станет поисковым запросом для видео, поэтому в нём должны быть имена,
организации, место и год, а не общие слова.
summary — 2–3 предложения на русском.
eventDate — YYYY-MM-DD, если известна точно; eventYear — год, если известен.
entities — участники: люди, организации, команды, места, продукты. aliases — другие написания
и языковые варианты (латиница/кириллица), они нужны для поиска.
facts — 5–12 проверяемых утверждений, у каждого sourceUrls из переданных адресов.
Факт без источника не включай.

Ответь СТРОГО валидным JSON:
{"canonicalEvent":"...","summary":"...","eventDate":"2022-12-04","eventYear":2022,"location":"...",
"language":"en","entities":[{"name":"...","type":"PERSON","aliases":["..."]}],
"facts":[{"text":"...","sourceUrls":["https://..."]}]}`;

function shortId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function classifySource(url: string, isNews: boolean): SourceType {
  const d = domainOf(url);
  if (/(youtube|youtu\.be|vimeo|dailymotion|rutube)/.test(d)) return "VIDEO";
  if (/(twitter|x\.com|instagram|tiktok|facebook|reddit|t\.me)/.test(d)) return "SOCIAL";
  if (/\.(gov|gov\.[a-z]{2}|org)$/.test(d) || /(wikipedia|uefa|fifa|nasa|who\.int)/.test(d)) return "OFFICIAL";
  return isNews ? "NEWS" : "OTHER";
}

/** Забирает заголовок и описание страницы, если пользователь дал ссылку. */
async function fetchOriginContext(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Gudini/1.0 (news research)" } });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 200_000);
    const title = html.match(/<title[^>]*>([^<]{3,300})<\/title>/i)?.[1] ?? "";
    const desc =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,600})["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,600})["']/i)?.[1] ??
      "";
    const published =
      html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";
    return `ИСХОДНАЯ ССЫЛКА: ${url}\nЗаголовок: ${title}\nОписание: ${desc}\nДата публикации: ${published}\n`;
  } catch {
    return "";
  }
}

/**
 * Собирает пакет исследования. Компактно: пара новостных запросов плюс один
 * веб-запрос для контекста, затем ОДИН вызов модели, которая сводит это в факты.
 */
export async function buildStoryResearchPack(
  topic: string,
  originUrl?: string,
): Promise<StoryResearchPack | null> {
  const key = getSettings().anthropicKey;
  if (!key) return null;

  const originContext = originUrl ? await fetchOriginContext(originUrl) : "";

  // новости — основной канал: они дают дату, участников и первоисточники
  const news: BraveResult[] = [...(await braveNews(topic)), ...(await braveNews(`${topic} что произошло`))];
  const web: BraveResult[] = await braveWeb(topic);

  const pool = [...news, ...web];
  if (!pool.length && !originContext) return null;

  const list = pool
    .slice(0, 24)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description ?? "").slice(0, 240)}${r.age ? `\n   дата: ${r.age}` : ""}`)
    .join("\n");

  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: RESEARCH_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Тема: ${topic}\n\n${originContext}\nРезультаты поиска:\n${list}`,
      },
    ],
  });
  addCost({ researchLlmCalls: 1 });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();

  try {
    const json = JSON.parse(raw);
    const storyId = shortId(`${topic}|${originUrl ?? ""}|${Date.now()}`);

    const entities: StoryEntity[] = (Array.isArray(json.entities) ? json.entities : [])
      .map((e: any) => ({
        id: shortId(String(e.name ?? "")),
        name: String(e.name ?? "").trim(),
        type: (["PERSON", "ORG", "TEAM", "PLACE", "PRODUCT", "EVENT"] as EntityType[]).includes(e.type)
          ? (e.type as EntityType)
          : "EVENT",
        aliases: Array.isArray(e.aliases) ? e.aliases.map(String).filter(Boolean).slice(0, 6) : [],
      }))
      .filter((e: StoryEntity) => e.name.length > 1)
      .slice(0, 12);

    const knownUrls = new Set(pool.map((r) => r.url));
    if (originUrl) knownUrls.add(originUrl);

    const facts: StoryFact[] = (Array.isArray(json.facts) ? json.facts : [])
      .map((f: any) => ({
        id: shortId(String(f.text ?? "")),
        text: String(f.text ?? "").trim(),
        // источник обязан быть из числа реально найденных — выдуманные ссылки отсекаем
        sourceUrls: (Array.isArray(f.sourceUrls) ? f.sourceUrls.map(String) : []).filter((u: string) =>
          knownUrls.has(u),
        ),
      }))
      .filter((f: StoryFact) => f.text.length > 8 && f.sourceUrls.length)
      .slice(0, 14);

    const sources: StorySource[] = pool.slice(0, 20).map((r) => ({
      url: r.url,
      domain: domainOf(r.url),
      title: r.title,
      publishedAt: r.age,
      type: classifySource(r.url, news.includes(r)),
    }));
    if (originUrl && !sources.some((s) => s.url === originUrl)) {
      sources.unshift({ url: originUrl, domain: domainOf(originUrl), type: "NEWS" });
    }

    const canonicalEvent = String(json.canonicalEvent ?? "").trim();
    if (!canonicalEvent || !entities.length) return null;

    return {
      storyId,
      topic,
      originUrl,
      canonicalEvent,
      summary: String(json.summary ?? "").trim(),
      eventDate: json.eventDate ? String(json.eventDate) : undefined,
      eventYear: Number.isFinite(Number(json.eventYear)) ? Number(json.eventYear) : undefined,
      location: json.location ? String(json.location) : undefined,
      language: json.language ? String(json.language) : undefined,
      entities,
      facts,
      sources,
      createdAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
