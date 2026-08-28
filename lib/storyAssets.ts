import crypto from "crypto";
import fs from "fs";
import path from "path";
import { StoryResearchPack, StoryEntity } from "./storyResearch";
import { braveVideos, braveImages, braveWeb, BraveVideo } from "./braveSearch";
import { mediaFromPage, isDirectMedia } from "./brollVideo";
import { analyzeAsset } from "./brollRelevance";
import { addCost } from "./pipelineCost";
import { probe, runFfmpeg } from "./ffmpeg";
import { mediaComplete } from "./mediaLlm";
import { getSettings } from "./store";

/**
 * Story Asset Pack — медиатека ОДНОЙ истории, собранная до монтажа.
 *
 * Раньше каждая фраза искала визуал с нуля и монтажёр брал что нашлось. Теперь
 * поиск идёт на уровне истории: запросы строятся из события, даты и участников,
 * кандидаты проверяются дважды (источник и кадр), и только проверенные попадают
 * в пакет. Планировщик потом выбирает ТОЛЬКО из него.
 */

/** Версия правил проверки: при изменении правил старые ассеты считаются непроверенными. */
export const VERIFICATION_VERSION = 1;

export type StoryAsset = {
  id: string;
  mediaType: "VIDEO" | "IMAGE";
  sourceUrl: string;
  sourceDomain: string;
  directUrl: string;
  title?: string;
  /** локальный файл, готовый к монтажу */
  localFile?: string;
  relatedEntityIds: string[];
  relatedFactIds: string[];
  eventDate?: string;
  description: string;
  durationSec?: number;
  verification: {
    sourceVerified: boolean;
    visualVerified: boolean;
    verificationVersion: number;
    reasons: string[];
  };
  videoSegments?: { start: number; end: number; description: string }[];
  /** EVENT — видно само событие; PERSON — участник вне события; CONTEXT — обстановка */
  role?: "EVENT" | "PERSON" | "CONTEXT" | "OFF_STORY";
};

export type StoryAssetPack = {
  storyId: string;
  verificationVersion: number;
  assets: StoryAsset[];
  createdAt: string;
};

const UA = { "User-Agent": "Gudini/1.0 (short-video editor)" };
const MAX_CANDIDATES = 40;
const MAX_VISION = 18;

const sid = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
const norm = (s: string) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Запросы строятся из ВСЕЙ истории: событие, участники, год, место.
 * Раньше запрос знал только текущую фразу, поэтому «Англия побеждает» искало
 * сборную Англии вообще, а не конкретный матч конкретного турнира.
 */
export function buildQueries(research: StoryResearchPack): string[] {
  const year = research.eventYear ? String(research.eventYear) : "";
  const people = research.entities.filter((e) => e.type === "PERSON").map((e) => e.name);
  const orgs = research.entities.filter((e) => e.type === "TEAM" || e.type === "ORG").map((e) => e.name);
  const place = research.location ?? "";

  const queries = [
    research.canonicalEvent,
    [people[0], research.canonicalEvent.split(" ").slice(0, 6).join(" "), year].filter(Boolean).join(" "),
    [people[0], orgs[0], year].filter(Boolean).join(" "),
    [orgs[0], orgs[1], year].filter(Boolean).join(" "),
    [people[0], place, year].filter(Boolean).join(" "),
    [people[0], "interview"].filter(Boolean).join(" "),
  ];
  // алиасы дают вариант на другом языке/написании
  const alias = research.entities.find((e) => e.aliases.length)?.aliases[0];
  if (alias) queries.push([alias, year].filter(Boolean).join(" "));

  return [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 4))].slice(0, 7);
}

type Candidate = {
  mediaType: "VIDEO" | "IMAGE";
  sourceUrl: string;
  directUrl: string;
  title: string;
  description?: string;
  publisher?: string;
  durationSec?: number;
  query: string;
};

/** Ключ дедупликации: нормализованная ссылка без параметров. */
function dedupeKey(c: Candidate): string {
  try {
    const u = new URL(c.directUrl);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return c.directUrl.toLowerCase();
  }
}

/**
 * ИСТОЧНИКОВАЯ проверка — по метаданным, без зрения.
 * Отвечает на вопрос «про эту ли историю материал»: та ли сущность, тот ли год.
 * Зрение на такие вопросы отвечать не умеет, оно видит «футбол, стадион».
 */

/**
 * Известные крупные турниры. Нужны для одной конкретной проверки: источник может
 * упоминать героя истории и при этом рассказывать о ДРУГОМ соревновании.
 * Так в медиатеку попало фото «Henderson ... during Ajax Europa League match» —
 * имя совпало, года в тексте не было, и материал чужого события прошёл как свой.
 */
const COMPETITIONS: Record<string, RegExp> = {
  "world cup": /\bworld cup|мундиал|чемпионат мира\b/i,
  "europa league": /\beuropa league|лига европы\b/i,
  "champions league": /\bchampions league|лига чемпионов\b/i,
  "conference league": /\bconference league\b/i,
  "premier league": /\bpremier league\b/i,
  "la liga": /\bla liga\b/i,
  "serie a": /\bserie a\b/i,
  "bundesliga": /\bbundesliga\b/i,
  "ligue 1": /\bligue 1\b/i,
  "fa cup": /\bfa cup\b/i,
  "efl cup": /\befl cup|carabao cup\b/i,
  "euro": /\beuro 20\d\d|european championship\b/i,
  "nations league": /\bnations league\b/i,
  "copa america": /\bcopa america|copa américa\b/i,
  "olympics": /\bolympics?|олимпиад\b/i,
  "club friendly": /\bfriendly match|товарищеск\b/i,
};

/**
 * Называет ли источник соревнование, отличное от того, о котором история.
 * Проверка срабатывает только когда у истории турнир известен и в источнике
 * назван другой: молчание источника поводом для отказа не является.
 */
export function conflictingCompetition(hay: string, research: StoryResearchPack): string | null {
  const storyText = norm(
    [research.canonicalEvent, ...research.entities.map((e) => [e.name, ...e.aliases].join(" "))].join(" "),
  );
  const storyComps = Object.keys(COMPETITIONS).filter((k) => COMPETITIONS[k].test(storyText));
  if (!storyComps.length) return null;
  const sourceComps = Object.keys(COMPETITIONS).filter((k) => COMPETITIONS[k].test(hay));
  if (!sourceComps.length) return null;
  const foreign = sourceComps.filter((c) => !storyComps.includes(c));
  if (foreign.length && !sourceComps.some((c) => storyComps.includes(c))) return foreign[0];
  return null;
}

export function verifySource(
  c: Pick<Candidate, "title" | "description" | "sourceUrl" | "publisher">,
  research: StoryResearchPack,
): { ok: boolean; entityIds: string[]; reasons: string[] } {
  const hay = norm(`${c.title} ${c.description ?? ""} ${c.sourceUrl} ${c.publisher ?? ""}`);
  const reasons: string[] = [];

  const matched: string[] = [];
  for (const e of research.entities) {
    const names = [e.name, ...e.aliases].map(norm).filter((n) => n.length > 2);
    if (names.some((n) => hay.includes(n))) matched.push(e.id);
  }
  if (!matched.length) {
    reasons.push("ни одна сущность истории не упомянута в источнике");
    return { ok: false, entityIds: [], reasons };
  }

  // год: если в тексте есть ДРУГОЙ год события, это материал другой истории
  const year = research.eventYear;
  if (year) {
    const years = [...hay.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    if (years.length && !years.includes(year)) {
      const near = years.some((y) => Math.abs(y - year) <= 1);
      if (!near) {
        reasons.push(`год не совпадает: в источнике ${years.join("/")}, у истории ${year}`);
        return { ok: false, entityIds: matched, reasons };
      }
    }
  }
  // другое соревнование при том же герое — это другое событие, а не наша история
  const foreign = conflictingCompetition(hay, research);
  if (foreign) {
    reasons.push(`источник о другом соревновании: ${foreign}`);
    return { ok: false, entityIds: matched, reasons };
  }

  return { ok: true, entityIds: matched, reasons };
}

async function collectCandidates(research: StoryResearchPack): Promise<Candidate[]> {
  const queries = buildQueries(research);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (c: Candidate) => {
    const key = dedupeKey(c);
    if (seen.has(key) || out.length >= MAX_CANDIDATES) return;
    seen.add(key);
    out.push(c);
  };

  // 1) ВИДЕО — главный канал
  for (const q of queries) {
    for (const v of await braveVideos(q)) {
      const direct = v.directUrl;
      if (direct) {
        add({
          mediaType: "VIDEO",
          sourceUrl: v.url,
          directUrl: direct,
          title: v.title,
          description: v.description,
          publisher: v.publisher,
          durationSec: v.durationSec,
          query: q,
        });
      } else {
        // страница плеера — источник обнаружения: пробуем достать медиапоток штатно
        const media = await mediaFromPage(v.url, q);
        addCost({ pageFetches: 1 });
        for (const m of media) {
          if (m.mediaType !== "video") continue;
          add({
            mediaType: "VIDEO",
            sourceUrl: v.url,
            directUrl: m.directUrl,
            title: v.title || (m.title ?? ""),
            description: v.description,
            publisher: v.publisher,
            durationSec: v.durationSec,
            query: q,
          });
        }
      }
    }
  }

  // 2) ИЗОБРАЖЕНИЯ — когда видео нет
  for (const q of queries.slice(0, 5)) {
    for (const im of await braveImages(q)) {
      add({
        mediaType: "IMAGE",
        sourceUrl: im.url,
        directUrl: im.imageUrl,
        title: im.title,
        description: im.description,
        query: q,
      });
    }
  }

  // 3) ВЕБ — только добор контекста из статей истории
  for (const q of queries.slice(0, 2)) {
    for (const page of (await braveWeb(q)).slice(0, 4)) {
      const media = await mediaFromPage(page.url, q);
      addCost({ pageFetches: 1 });
      for (const m of media) {
        add({
          mediaType: m.mediaType === "video" ? "VIDEO" : "IMAGE",
          sourceUrl: page.url,
          directUrl: m.directUrl,
          title: page.title || (m.title ?? ""),
          description: page.description,
          query: q,
        });
      }
    }
  }
  return out;
}

/** Скачивает файл; для видео ограничиваем размер, чтобы не тянуть часовые записи. */
async function download(url: string, out: string, maxBytes: number): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return false;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > maxBytes) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 8_000 || buffer.length > maxBytes) return false;
    fs.writeFileSync(out, buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разбирает найденное видео ОДИН раз: сэмплирует кадры по таймлайну, описывает их
 * зрением и превращает в несколько независимых сегментов. Один хороший ролик
 * события может закрыть заметную часть монтажа.
 */
async function analyzeVideoSegments(
  file: string,
  dir: string,
  research: StoryResearchPack,
): Promise<{ segments: StoryAsset["videoSegments"]; description: string; duration: number } | null> {
  let duration = 0;
  try {
    duration = (await probe(file)).duration;
  } catch {
    return null;
  }
  if (duration < 2) return null;

  const samples = Math.min(5, Math.max(2, Math.floor(duration / 6)));
  const segments: NonNullable<StoryAsset["videoSegments"]> = [];
  const descriptions: string[] = [];
  const base = path.basename(file, path.extname(file));

  for (let i = 0; i < samples; i++) {
    const at = ((i + 0.5) / samples) * Math.max(0, duration - 2);
    const frame = path.join(dir, `seg-${base}-${i}.jpg`);
    try {
      await runFfmpeg(
        ["-ss", at.toFixed(2), "-i", path.basename(file), "-frames:v", "1", "-q:v", "4", path.basename(frame)],
        { cwd: dir },
      );
      const an = await analyzeAsset(`seg:${base}:${i}`, "", fs.readFileSync(frame));
      addCost({ visionCalls: 1 });
      if (!an) continue;
      if (an.isScreenshot || an.hasLargeWatermark) continue; // интерфейс плеера и водяные знаки не берём
      descriptions.push(an.description);
      segments.push({
        start: Number(at.toFixed(2)),
        end: Number(Math.min(duration, at + 3).toFixed(2)),
        description: an.description,
      });
    } catch {
    } finally {
      try {
        fs.rmSync(frame, { force: true });
      } catch {}
    }
  }
  if (!segments.length) return null;
  return { segments, description: descriptions[0] ?? "", duration };
}

/**
 * Строит медиатеку истории. Один проход на всю историю вместо поиска под каждую фразу.
 */
export async function buildStoryAssetPack(
  research: StoryResearchPack,
  dir: string,
): Promise<StoryAssetPack> {
  const mediaDir = path.join(dir, "story-assets");
  fs.mkdirSync(mediaDir, { recursive: true });

  const candidates = await collectCandidates(research);

  // ИСТОЧНИКОВАЯ проверка идёт ДО зрения: она бесплатна и отсекает чужие истории
  const sourceOk = candidates
    .map((c) => ({ c, v: verifySource(c, research) }))
    .filter((x) => x.v.ok);

  // видео вперёд: для короткого монтажа движение важнее статики
  sourceOk.sort((a, b) => (a.c.mediaType === b.c.mediaType ? 0 : a.c.mediaType === "VIDEO" ? -1 : 1));

  const assets: StoryAsset[] = [];
  let visionUsed = 0;

  for (const { c, v } of sourceOk) {
    if (visionUsed >= MAX_VISION) break;
    const id = sid(c.directUrl);
    const ext = c.mediaType === "VIDEO" ? ".mp4" : ".jpg";
    const local = path.join(mediaDir, `${id}${ext}`);

    if (!(await download(c.directUrl, local, c.mediaType === "VIDEO" ? 90_000_000 : 12_000_000))) continue;
    addCost(c.mediaType === "VIDEO" ? { videoDownloads: 1 } : {});

    let description = "";
    let segments: StoryAsset["videoSegments"];
    let durationSec: number | undefined;
    let visualOk = false;

    if (c.mediaType === "VIDEO") {
      const analyzed = await analyzeVideoSegments(local, mediaDir, research);
      visionUsed += 1;
      if (analyzed) {
        description = analyzed.description;
        segments = analyzed.segments;
        durationSec = analyzed.duration;
        visualOk = true;
      }
    } else {
      const an = await analyzeAsset(`story:${id}`, "", fs.readFileSync(local));
      addCost({ visionCalls: 1 });
      visionUsed += 1;
      if (an && !an.isScreenshot && !an.hasLargeText && !an.hasLargeWatermark) {
        description = an.description;
        visualOk = true;
      }
    }

    if (!visualOk) {
      try {
        fs.rmSync(local, { force: true });
      } catch {}
      continue;
    }

    assets.push({
      id,
      mediaType: c.mediaType,
      sourceUrl: c.sourceUrl,
      sourceDomain: (() => {
        try {
          return new URL(c.sourceUrl).hostname.replace(/^www\./, "");
        } catch {
          return "unknown";
        }
      })(),
      directUrl: c.directUrl,
      title: c.title,
      localFile: path.relative(dir, local).replace(/\\/g, "/"),
      relatedEntityIds: v.entityIds,
      relatedFactIds: [],
      eventDate: research.eventDate,
      description,
      durationSec,
      verification: {
        sourceVerified: true,
        visualVerified: true,
        verificationVersion: VERIFICATION_VERSION,
        reasons: [],
      },
      videoSegments: segments,
    });
  }

  // привязка к фактам и отсев чужих материалов по описанию кадра
  const annotated = await annotateAssets(assets, research);

  const pack: StoryAssetPack = {
    storyId: research.storyId,
    verificationVersion: VERIFICATION_VERSION,
    assets: annotated,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(dir, "story-asset-pack.json"), JSON.stringify(pack, null, 2), "utf8");
  } catch {}
  return pack;
}

const ANNOTATE_SYSTEM = `Ты — ассистент видеоредактора. Тебе дают историю с фактами и список
найденных материалов с описанием того, ЧТО НА НИХ ВИДНО.

Для каждого материала реши:
1) относится ли он к ЭТОЙ истории (те же участники/команды/событие) — belongs;
2) какие факты он может проиллюстрировать — factIds (может быть пусто);
3) показывает ли он САМО событие или только участника/контекст — role.

Строго: материал, где видны другие команды, другая форма, другие люди или другой инцидент,
к истории НЕ относится, даже если страница про неё. Кадр студийного разговора или интервью —
это участник, а не событие.

Ответь СТРОГО валидным JSON:
{"items":[{"id":"...","belongs":true,"factIds":["f1"],"role":"EVENT|PERSON|CONTEXT","visible":"кратко что видно"}]}
role: EVENT — видно само событие; PERSON — виден участник вне события; CONTEXT — обстановка истории.`;

/**
 * Привязывает материалы к фактам и отсекает чужие.
 * Источниковая проверка работает по метаданным страницы и пропускает случаи, когда
 * страница про нашу историю, а на кадре — другая команда. Здесь решение принимается
 * по ОПИСАНИЮ КАДРА, уже полученному зрением, поэтому дополнительных vision-вызовов нет.
 */
export async function annotateAssets(
  assets: StoryAsset[],
  research: StoryResearchPack,
): Promise<StoryAsset[]> {
  const key = getSettings().anthropicKey;
  if (!key || !assets.length) return assets;

  const facts = research.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const list = assets
    .map((a) => {
      const segs = a.videoSegments?.length
        ? ` | сегменты: ${a.videoSegments.map((s, i) => `#${i} ${s.description.slice(0, 70)}`).join(" ; ")}`
        : "";
      return `id=${a.id} [${a.mediaType}] источник ${a.sourceDomain}: ${a.description.slice(0, 120)}${segs}`;
    })
    .join("\n");

  try {
    const response = await mediaComplete({
      system: ANNOTATE_SYSTEM,
      maxTokens: 4000,
      stage: "Source Verification",
      user:
        `История: ${research.canonicalEvent}\n` +
        (research.eventDate ? `Дата: ${research.eventDate}\n` : "") +
        `Участники: ${research.entities.map((e) => e.name).join(", ")}\n\n` +
        `Факты:\n${facts}\n\nМатериалы:\n${list}`,
    });
    addCost({ researchLlmCalls: 1 });
    const raw = response
      .replace(/^```(json)?/m, "")
      .replace(/```$/m, "")
      .trim();
    const json = JSON.parse(raw);
    const byId = new Map<string, any>((Array.isArray(json.items) ? json.items : []).map((i: any) => [String(i.id), i]));
    const known = new Set(research.facts.map((f) => f.id));

    return assets.map((a) => {
      const info = byId.get(a.id);
      if (!info || info.belongs === false) {
        return {
          ...a,
          relatedFactIds: [],
          role: "OFF_STORY" as const,
          verification: {
            ...a.verification,
            sourceVerified: false,
            reasons: [...a.verification.reasons, "материал не относится к этой истории"],
          },
        };
      }
      return {
        ...a,
        relatedFactIds: (Array.isArray(info.factIds) ? info.factIds.map(String) : []).filter((f: string) => known.has(f)),
        role: (["EVENT", "PERSON", "CONTEXT"] as const).includes(info.role) ? info.role : "CONTEXT",
        description: info.visible ? String(info.visible).slice(0, 160) : a.description,
      };
    });
  } catch {
    return assets;
  }
}

/** Ассет считается пригодным, только если проверен ТЕКУЩЕЙ версией правил. */
export function isUsable(asset: StoryAsset): boolean {
  return (
    asset.verification.sourceVerified &&
    asset.verification.visualVerified &&
    asset.verification.verificationVersion === VERIFICATION_VERSION
  );
}
