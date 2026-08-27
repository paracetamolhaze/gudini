import crypto from "crypto";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store";
import { StoryResearchPack } from "./storyResearch";
import { ScriptBeat, MediaResearchNeed } from "./scriptBeats";
import { braveVideos, braveImages } from "./braveSearch";
import { analyzeAsset } from "./brollRelevance";
import { fetchVideo, extractorReady } from "./videoFetch";
import { verifySource } from "./storyAssets";
import { addCost } from "./pipelineCost";
import { probe, runFfmpeg } from "./ffmpeg";

/**
 * Медиатека истории, версия 2: два слоя.
 *
 * CORE — один глубокий заход за настоящим видео события: если найден нормальный
 * сюжет на минуту-две, он режется на много самостоятельных сегментов и закрывает
 * заметную часть ролика. Это принципиально лучше, чем десять фотографий с разных
 * сайтов.
 * BEAT — точечный добор под те блоки сценария, которые CORE не закрыл. Запрос
 * при этом всегда знает и всю историю (событие, год, участники), и конкретный блок,
 * поэтому это не возврат к слепому поиску по фразе.
 */

export const PACK_VERSION = 2;

export type AssetKind = "VIDEO_SEGMENT" | "IMAGE";

export type PackAsset = {
  id: string;
  kind: AssetKind;
  /** файл, готовый к монтажу (уже вырезанный сегмент или картинка) */
  file: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceVideoId?: string;
  segment?: { start: number; end: number };
  description: string;
  role: "EVENT" | "PERSON" | "CONTEXT";
  compatibleBeatIds: string[];
  relatedFactIds: string[];
  verification: { sourceVerified: boolean; visualVerified: boolean; version: number };
};

export type BeatCoverage = {
  beatId: string;
  text: string;
  need: string;
  videos: number;
  images: number;
  covered: boolean;
};

export type StoryAssetPackV2 = {
  storyId: string;
  version: number;
  assets: PackAsset[];
  coverage: BeatCoverage[];
  coverageRatio: number;
  sourceVideos: { id: string; url: string; durationSec: number; segments: number; method?: string }[];
  createdAt: string;
};

const sid = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

/** Запросы за ГЛАВНЫМ видео истории: событие целиком, разными формулировками. */
function coreVideoQueries(r: StoryResearchPack): string[] {
  const year = r.eventYear ? String(r.eventYear) : "";
  const person = r.entities.find((e) => e.type === "PERSON")?.name ?? "";
  const teams = r.entities.filter((e) => e.type === "TEAM").map((e) => e.name);
  const event = r.entities.find((e) => e.type === "EVENT")?.name ?? "";
  return [
    r.canonicalEvent,
    [person, "injury", year].filter(Boolean).join(" "),
    [person, teams[0], teams[1], year].filter(Boolean).join(" "),
    [person, event].filter(Boolean).join(" "),
    [teams[0], teams[1], event, "highlights"].filter(Boolean).join(" "),
    [person, "stretcher OR injured OR celebration", year].filter(Boolean).join(" "),
  ].filter((q) => q.trim().length > 6);
}

/** Запрос под конкретный блок: контекст истории + что нужно показать. */
function beatQueries(r: StoryResearchPack, need: MediaResearchNeed): string[] {
  const year = r.eventYear ? String(r.eventYear) : "";
  const ents = need.entities.length ? need.entities.join(" ") : r.entities[0]?.name ?? "";
  const event = r.entities.find((e) => e.type === "EVENT")?.name ?? "";
  return [
    [ents, need.visualDescription].filter(Boolean).join(" ").slice(0, 120),
    [ents, need.visualDescription.split(" ").slice(0, 5).join(" "), year].filter(Boolean).join(" "),
    [need.visualDescription, event].filter(Boolean).join(" ").slice(0, 120),
  ].filter((q) => q.trim().length > 6);
}

/**
 * Режет исходное видео на самостоятельные сегменты: сэмплирует кадры, описывает
 * зрением и оставляет визуально разные моменты. Один сюжет даёт несколько вставок.
 */
async function cutSegments(
  file: string,
  dir: string,
  videoId: string,
  wanted: number,
): Promise<{ assets: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[]; duration: number }> {
  let duration = 0;
  try {
    duration = (await probe(file)).duration;
  } catch {
    return { assets: [], duration: 0 };
  }
  if (duration < 4) return { assets: [], duration };

  const samples = Math.min(wanted, Math.max(3, Math.floor(duration / 8)));
  const out: Omit<PackAsset, "compatibleBeatIds" | "relatedFactIds" | "role">[] = [];
  const seenDesc: string[] = [];

  for (let i = 0; i < samples; i++) {
    const at = ((i + 0.5) / samples) * Math.max(0, duration - 3);
    const frame = path.join(dir, `probe-${videoId}-${i}.jpg`);
    try {
      await runFfmpeg(
        ["-ss", at.toFixed(2), "-i", path.basename(file), "-frames:v", "1", "-q:v", "4", path.basename(frame)],
        { cwd: dir },
      );
      const an = await analyzeAsset(`seg:${videoId}:${i}`, "", fs.readFileSync(frame));
      addCost({ visionCalls: 1 });
      if (!an || an.isScreenshot || an.hasLargeWatermark) continue;
      // почти одинаковые кадры не плодим: сегменты должны отличаться
      if (seenDesc.some((d) => similar(d, an.description))) continue;
      seenDesc.push(an.description);

      const clip = path.join(dir, `seg-${videoId}-${i}.mp4`);
      await runFfmpeg(
        [
          "-ss", at.toFixed(2),
          "-i", path.basename(file),
          "-t", "3.2",
          "-an",
          "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
          "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
          path.basename(clip),
        ],
        { cwd: dir },
      );
      out.push({
        id: sid(`${videoId}:${i}`),
        kind: "VIDEO_SEGMENT",
        file: path.basename(clip),
        sourceUrl: "",
        sourceDomain: "",
        sourceVideoId: videoId,
        segment: { start: Number(at.toFixed(2)), end: Number((at + 3.2).toFixed(2)) },
        description: an.description,
        verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
      });
    } catch {
    } finally {
      try {
        fs.rmSync(frame, { force: true });
      } catch {}
    }
  }
  return { assets: out, duration };
}

function similar(a: string, b: string): boolean {
  const A = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const B = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.min(A.size, B.size) > 0.75;
}

const MATCH_SYSTEM = `Ты — ассистент монтажёра. Тебе дают историю, список ВИЗУАЛЬНЫХ БЛОКОВ сценария
и список найденных материалов с описанием того, что на них видно.

Для каждого материала укажи, какие блоки он может закрыть, и его честную роль:
EVENT — видно само событие/действие истории;
PERSON — виден участник вне события;
CONTEXT — обстановка истории.

Материал, где другие команды, другие люди, другой инцидент или другой турнир, к истории
не относится — верни для него пустой compatibleBeatIds и role CONTEXT.
Не присваивай EVENT, если на кадре не происходит именно описанное в истории действие.

Ответь СТРОГО валидным JSON:
{"items":[{"id":"...","role":"EVENT","beatIds":["b1_ab"],"factIds":["f1"]}]}`;

/** Сопоставляет материалы с блоками сценария одним вызовом. */
async function matchToBeats(
  assets: PackAsset[],
  beats: ScriptBeat[],
  research: StoryResearchPack,
): Promise<PackAsset[]> {
  const key = getSettings().anthropicKey;
  if (!key || !assets.length) return assets;
  const beatList = beats
    .filter((b) => b.visualNeed !== "NONE")
    .map((b) => `[${b.id}] (${b.visualNeed}) ${b.text}`)
    .join("\n");
  const assetList = assets.map((a) => `id=${a.id} [${a.kind}] ${a.description.slice(0, 120)}`).join("\n");

  try {
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 6000,
      system: MATCH_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `История: ${research.canonicalEvent}\nУчастники: ${research.entities.map((e) => e.name).join(", ")}\n\n` +
            `Блоки сценария:\n${beatList}\n\nМатериалы:\n${assetList}`,
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
    const json = JSON.parse(raw);
    const byId = new Map<string, any>((Array.isArray(json.items) ? json.items : []).map((i: any) => [String(i.id), i]));
    const beatIds = new Set(beats.map((b) => b.id));
    const factIds = new Set(research.facts.map((f) => f.id));

    return assets.map((a) => {
      const info = byId.get(a.id);
      if (!info) return { ...a, compatibleBeatIds: [], role: "CONTEXT" as const };
      return {
        ...a,
        role: (["EVENT", "PERSON", "CONTEXT"] as const).includes(info.role) ? info.role : "CONTEXT",
        compatibleBeatIds: (Array.isArray(info.beatIds) ? info.beatIds.map(String) : []).filter((b: string) =>
          beatIds.has(b),
        ),
        relatedFactIds: (Array.isArray(info.factIds) ? info.factIds.map(String) : []).filter((f: string) =>
          factIds.has(f),
        ),
      };
    });
  } catch {
    return assets;
  }
}

/**
 * Собирает медиатеку под конкретный сценарий.
 * Сначала CORE (главное видео истории), потом BEAT (добор под незакрытые блоки).
 */
export async function buildAssetPack(
  research: StoryResearchPack,
  beats: ScriptBeat[],
  needs: MediaResearchNeed[],
  dir: string,
): Promise<StoryAssetPackV2> {
  const mediaDir = path.join(dir, "story-assets");
  fs.mkdirSync(mediaDir, { recursive: true });
  const assets: PackAsset[] = [];
  const sourceVideos: StoryAssetPackV2["sourceVideos"] = [];
  const seenVideo = new Set<string>();

  console.log(`Медиатека: экстрактор видео ${(await extractorReady()) ? "доступен" : "не установлен"}`);

  // ---------- CORE: главное видео истории ----------
  const coreQueries = coreVideoQueries(research);
  let coreSegments = 0;
  for (const q of coreQueries) {
    if (coreSegments >= 10) break;
    for (const v of await braveVideos(q)) {
      if (coreSegments >= 10) break;
      const vid = sid(v.url);
      if (seenVideo.has(vid)) continue;
      const src = verifySource({ title: v.title, description: v.description, sourceUrl: v.url, publisher: v.publisher }, research);
      if (!src.ok) continue;
      seenVideo.add(vid);

      const raw = path.join(mediaDir, `src-${vid}.mp4`);
      const got = await fetchVideo(v.directUrl, v.url, raw);
      if (!got.ok) {
        console.log(`  видео ${v.url.slice(0, 60)} → ${got.reason}`);
        continue;
      }
      const cut = await cutSegments(raw, mediaDir, vid, 6);
      if (!cut.assets.length) continue;
      sourceVideos.push({ id: vid, url: v.url, durationSec: cut.duration, segments: cut.assets.length, method: got.method });
      for (const a of cut.assets) {
        assets.push({
          ...a,
          sourceUrl: v.url,
          sourceDomain: (() => {
            try {
              return new URL(v.url).hostname.replace(/^www\./, "");
            } catch {
              return "unknown";
            }
          })(),
          compatibleBeatIds: [],
          relatedFactIds: [],
          role: "CONTEXT",
        });
      }
      coreSegments += cut.assets.length;
      try {
        fs.rmSync(raw, { force: true });
      } catch {}
    }
  }

  // ---------- BEAT: добор под блоки, приоритет важным ----------
  const ordered = [...needs].sort((a, b) => (a.importance === "HIGH" ? -1 : b.importance === "HIGH" ? 1 : 0));
  const seenImage = new Set<string>();
  for (const need of ordered) {
    if (assets.length >= 26) break;
    for (const q of beatQueries(research, need).slice(0, need.importance === "HIGH" ? 3 : 2)) {
      for (const im of (await braveImages(q)).slice(0, 6)) {
        if (assets.length >= 26) break;
        const key = im.imageUrl.split("?")[0];
        if (seenImage.has(key)) continue;
        const src = verifySource({ title: im.title, description: im.description, sourceUrl: im.url }, research);
        if (!src.ok) continue;
        seenImage.add(key);

        const id = sid(key);
        const file = path.join(mediaDir, `img-${id}.jpg`);
        try {
          const res = await fetch(im.imageUrl, { headers: { "User-Agent": "Gudini/1.0" } });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 10_000) continue;
          const an = await analyzeAsset(`img:${id}`, "", buf);
          addCost({ visionCalls: 1 });
          if (!an || an.isScreenshot || an.hasLargeText || an.hasLargeWatermark) continue;
          fs.writeFileSync(file, buf);
          assets.push({
            id,
            kind: "IMAGE",
            file: path.basename(file),
            sourceUrl: im.url,
            sourceDomain: (() => {
              try {
                return new URL(im.url).hostname.replace(/^www\./, "");
              } catch {
                return "unknown";
              }
            })(),
            description: an.description,
            role: "CONTEXT",
            compatibleBeatIds: [],
            relatedFactIds: [],
            verification: { sourceVerified: true, visualVerified: true, version: PACK_VERSION },
          });
        } catch {}
      }
    }
  }

  // ---------- сопоставление с блоками ----------
  const matched = await matchToBeats(assets, beats, research);
  const usable = matched.filter((a) => a.compatibleBeatIds.length);

  const visual = beats.filter((b) => b.visualNeed !== "NONE");
  const coverage: BeatCoverage[] = visual.map((b) => {
    const fit = usable.filter((a) => a.compatibleBeatIds.includes(b.id));
    return {
      beatId: b.id,
      text: b.text.slice(0, 60),
      need: b.visualNeed,
      videos: fit.filter((a) => a.kind === "VIDEO_SEGMENT").length,
      images: fit.filter((a) => a.kind === "IMAGE").length,
      covered: fit.length > 0,
    };
  });
  const coverageRatio = visual.length ? Number((coverage.filter((c) => c.covered).length / visual.length).toFixed(2)) : 0;

  const pack: StoryAssetPackV2 = {
    storyId: research.storyId,
    version: PACK_VERSION,
    assets: usable,
    coverage,
    coverageRatio,
    sourceVideos,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(dir, "story-asset-pack.json"), JSON.stringify(pack, null, 2), "utf8");
  } catch {}
  return pack;
}
