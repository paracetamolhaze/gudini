import fs from "fs";
import path from "path";
import { mediaComplete } from "./mediaLlm";
import { getSettings } from "./store";
import { Word } from "./transcribe";
import { EditEvent, EditPlan, DEFAULT_CAPTION_STYLE } from "./editPlan";
import { StoryResearchPack } from "./storyResearch";
import { StoryAssetPack, StoryAsset, isUsable } from "./storyAssets";
import { addCost } from "./pipelineCost";
import { runFfmpeg } from "./ffmpeg";

/**
 * Монтажный планировщик поверх готовой медиатеки.
 *
 * Ключевое отличие от прежней схемы: у планировщика НЕТ поиска. Он получает
 * очищенную транскрипцию и проверенный пакет ассетов и только расставляет их
 * по таймлайну. Случайная картинка из интернета сюда физически не попадёт —
 * любой id вне пакета отбрасывается валидацией.
 */

const MODEL = "claude-sonnet-5";
const MIN_LEN = 1.5;
const MAX_LEN = 5.0;
const MAX_EVENTS = 16;

const SYSTEM = `Ты — монтажёр короткого вертикального видео. Автор читает сценарий на камеру.
Тебе дают: транскрипцию с таймкодами, факты истории и ГОТОВУЮ медиатеку — проверенные материалы
именно про эту историю. Твоя работа — расставить материалы по таймлайну.

Правила:
- Использовать МОЖНО только материалы из медиатеки, по их id. Ничего другого не существует.
- Ставь материал туда, где он совпадает по смыслу с произносимой фразой. Не иллюстрируй слово —
  иллюстрируй мысль.
- Длительность вставки 1.5–4 сек, у сильного видео до 5. Визуал должен меняться каждые 2–4 секунды.
- Первые ~2 секунды — лицо автора, туда вставки не ставь.
- Один и тот же материал не повторяй. У видео можно взять РАЗНЫЕ сегменты (segmentIndex) —
  это считается разными кадрами.
- Если для фразы в медиатеке нет ничего подходящего, НЕ ставь ничего: останется лицо автора.
  Это нормально и лучше, чем неподходящий кадр.
- Вставки не должны пересекаться.

Ответь СТРОГО валидным JSON:
{"placements":[{"assetId":"...","segmentIndex":0,"from":12,"to":19}]}
from/to — индексы слов транскрипции.`;

export type PackPlacement = { assetId: string; segmentIndex?: number; from: number; to: number };

/** Готовит клип из ассета: нужный сегмент видео или статичный кадр из фото. */
async function buildClipFromAsset(
  dir: string,
  asset: StoryAsset,
  seconds: number,
  segmentIndex: number,
  outName: string,
): Promise<boolean> {
  const src = asset.localFile ? path.join(dir, asset.localFile) : null;
  if (!src || !fs.existsSync(src)) return false;

  const filter =
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";
  const fit =
    "split=2[bg][fg];" +
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.06[bgb];" +
    "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];" +
    "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1";

  try {
    const dur = Math.max(1.5, seconds).toFixed(2);
    if (asset.mediaType === "VIDEO") {
      const seg = asset.videoSegments?.[segmentIndex] ?? asset.videoSegments?.[0];
      const start = seg?.start ?? 0;
      await runFfmpeg(
        [
          "-ss", start.toFixed(2),
          "-i", path.relative(dir, src).replace(/\\/g, "/"),
          "-t", dur,
          "-an", // звук внешнего видео не попадает в ролик никогда
          "-filter_complex", `[0:v]${fit}[v]`,
          "-map", "[v]",
          "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
          outName,
        ],
        { cwd: dir },
      );
    } else {
      await runFfmpeg(
        [
          "-loop", "1", "-t", dur,
          "-i", path.relative(dir, src).replace(/\\/g, "/"),
          "-filter_complex", `[0:v]${fit}[v]`,
          "-map", "[v]",
          "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
          outName,
        ],
        { cwd: dir },
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Строит план монтажа из пакета. Возвращает null, если планировщик недоступен.
 * Ассеты вне пакета и повторы одного и того же сегмента отбрасываются здесь же.
 */
export async function planFromAssetPack(
  dir: string,
  research: StoryResearchPack,
  pack: StoryAssetPack,
  words: Word[],
  duration: number,
): Promise<EditPlan | null> {
  const key = getSettings().anthropicKey;
  const usable = pack.assets.filter(isUsable);
  if (!key || words.length < 10 || !usable.length) return null;

  const catalogue = usable
    .map((a) => {
      const segs = a.videoSegments?.length
        ? ` сегменты: ${a.videoSegments.map((s, i) => `#${i} ${s.start.toFixed(1)}с — ${s.description.slice(0, 60)}`).join("; ")}`
        : "";
      return `id=${a.id} [${a.mediaType}] ${a.description.slice(0, 120)} (источник: ${a.sourceDomain})${segs}`;
    })
    .join("\n");

  const list = words.map((w, i) => `${i}:${w.word}`).join(" ");
  const response = await mediaComplete({
    model: MODEL,
    maxTokens: 8000,
    stage: "Creative Director",
    system: SYSTEM,
    user:
      `История: ${research.canonicalEvent}\n` +
      (research.eventDate ? `Дата: ${research.eventDate}\n` : "") +
      `\nМедиатека:\n${catalogue}\n\n` +
      `Транскрипция (индекс:слово), длительность ${duration.toFixed(1)} сек:\n${list}`,
  });
  addCost({ editPlannerCalls: 1 });

  const raw = response
    .replace(/^```(json)?/m, "")
    .replace(/```$/m, "")
    .trim();

  let placements: PackPlacement[];
  try {
    const json = JSON.parse(raw);
    placements = Array.isArray(json.placements) ? json.placements : [];
  } catch {
    return null;
  }

  const events = await materialize(dir, placements, usable, words, duration);
  return { version: 1, duration, events, captionStyle: { ...DEFAULT_CAPTION_STYLE } };
}

/** Превращает выбор планировщика в события плана: валидация, дедуп, сборка клипов. */
export async function materialize(
  dir: string,
  placements: PackPlacement[],
  usable: StoryAsset[],
  words: Word[],
  duration: number,
): Promise<EditEvent[]> {
  const byId = new Map(usable.map((a) => [a.id, a]));
  const usedSegments = new Set<string>();
  const events: EditEvent[] = [];
  let prevEnd = -Infinity;
  let k = 0;

  const sorted = [...placements].sort((a, b) => Number(a.from) - Number(b.from));
  for (const p of sorted) {
    if (events.length >= MAX_EVENTS) break;
    const asset = byId.get(String(p.assetId));
    if (!asset) continue; // материала нет в пакете — планировщик не может его выдумать

    const segIndex = Number.isFinite(Number(p.segmentIndex)) ? Math.max(0, Math.trunc(Number(p.segmentIndex))) : 0;
    const segKey = `${asset.id}#${asset.mediaType === "VIDEO" ? segIndex : 0}`;
    if (usedSegments.has(segKey)) continue; // тот же кадр второй раз не ставим

    const from = Math.max(0, Math.min(Math.trunc(Number(p.from)), words.length - 1));
    const to = Math.max(from, Math.min(Math.trunc(Number(p.to)), words.length - 1));
    let start = words[from]?.start;
    let end = (words[to]?.end ?? NaN) + 0.15;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 1.8) continue; // открывающая фраза — лицо автора

    if (end - start < MIN_LEN) end = start + MIN_LEN;
    if (end - start > MAX_LEN) end = start + MAX_LEN;
    end = Math.min(end, duration - 0.05);
    if (end - start < MIN_LEN * 0.8) continue;
    if (start < prevEnd + 0.25) continue; // пересечений быть не должно

    const file = `broll${k}.mp4`;
    if (!(await buildClipFromAsset(dir, asset, end - start, segIndex, file))) continue;

    usedSegments.add(segKey);
    events.push({
      type: "B_ROLL",
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      file,
      query: asset.description.slice(0, 80),
      entityName: asset.sourceDomain,
    });
    prevEnd = end;
    k++;
  }
  return events;
}
