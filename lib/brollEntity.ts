import fs from "fs";
import path from "path";
import { runFfmpeg, probe } from "./ffmpeg";
import type { WebAsset } from "./brollWeb";

/**
 * Превращает найденный в открытых источниках кадр в вертикальную перебивку.
 * Горизонтальный материал не отбрасывается: если объект помещается — обрезаем,
 * если важна вся ширина (команды, табло, панорама поля) — вписываем целиком
 * на размытый фон из того же кадра. Растягивать нельзя ни при каких условиях.
 */

const W = 1080;
const H = 1920;

export type Layout = "crop" | "fit";

/** Простая эвристика: очень широкий кадр теряет смысл при обрезке — его вписываем. */
export function chooseLayout(width: number, height: number): Layout {
  if (!width || !height) return "crop";
  const aspect = width / height;
  return aspect > 1.35 ? "fit" : "crop";
}

function videoFilter(layout: Layout): string {
  if (layout === "crop") {
    return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  }
  // фон — тот же кадр, увеличенный и размытый; поверх — оригинал целиком
  return (
    `split=2[bg][fg];` +
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.06[bgb];` +
    `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`
  );
}

/**
 * Ищет в длинном видео момент, который действительно соответствует смыслу.
 * Снимает несколько кадров по таймлайну, отдаёт их зрению и возвращает старт
 * лучшего окна. Без этого в ролик попадали первые секунды найденного видео —
 * заставка, студия, реклама.
 */
export async function pickBestSegment(
  file: string,
  needSeconds: number,
  score: (framePath: string) => Promise<number>,
  samples = 5,
): Promise<number> {
  let total = 0;
  try {
    total = (await probe(file)).duration;
  } catch {
    return 0;
  }
  const usable = Math.max(0, total - needSeconds);
  if (usable < 1) return 0;

  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const points = Array.from({ length: samples }, (_, i) => ((i + 0.5) / samples) * usable);
  let best = { at: 0, score: -1 };
  for (const at of points) {
    const frame = path.join(dir, `probe-${base}-${Math.round(at)}.jpg`);
    try {
      await runFfmpeg(["-ss", at.toFixed(2), "-i", path.basename(file), "-frames:v", "1", "-q:v", "4", path.basename(frame)], { cwd: dir });
      const s = await score(frame);
      if (s > best.score) best = { at, score: s };
    } catch {
    } finally {
      try {
        fs.rmSync(frame, { force: true });
      } catch {}
    }
  }
  return best.score > 0 ? best.at : 0;
}

async function download(url: string, outFile: string): Promise<boolean> {
  const res = await fetch(url, { headers: { "User-Agent": "Gudini/1.0 (short-video editor)" } });
  if (!res.ok) return false;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 8_000) return false;
  fs.writeFileSync(outFile, buffer);
  return true;
}

/** Строит клип нужной длины из веб-ассета (изображение или видео). */
export async function buildWebAssetClip(
  asset: WebAsset,
  outPath: string,
  duration: number,
  buffer?: Buffer,
  /** оценщик кадра: если задан, из длинного видео выбирается подходящий момент */
  scoreFrame?: (framePath: string) => Promise<number>,
): Promise<{ ok: boolean; layout?: Layout; localPath?: string; segmentStart?: number }> {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath, ".mp4");
  const ext = asset.mediaType === "video" ? ".src" : path.extname(new URL(asset.directUrl).pathname) || ".jpg";
  const src = path.join(dir, `web-${base}${ext}`);

  let segmentStart = 0;
  try {
    // байты уже скачаны на этапе смысловой проверки — повторно не тянем
    if (buffer) fs.writeFileSync(src, buffer);
    else if (!(await download(asset.directUrl, src))) return { ok: false };
    let width = 0;
    let height = 0;
    try {
      const info = await probe(src);
      width = info.width;
      height = info.height;
    } catch {
      // изображение без видеопотока probe может не прочитать — берём crop по умолчанию
    }
    const layout = chooseLayout(width, height);
    const filter = videoFilter(layout);
    const dur = Math.max(2, duration).toFixed(2);

    // из длинного видео берём не первые секунды, а осмысленный фрагмент
    if (asset.mediaType === "video" && scoreFrame) {
      segmentStart = await pickBestSegment(src, Math.max(2, duration), scoreFrame);
    }

    const args =
      asset.mediaType === "video"
        ? [
            ...(segmentStart > 0 ? ["-ss", segmentStart.toFixed(2)] : []),
            "-i", path.basename(src),
            "-t", dur,
            "-an", // внешнее видео всегда без звука
            "-filter_complex", `[0:v]${filter}[v]`,
            "-map", "[v]",
          ]
        : ["-loop", "1", "-t", dur, "-i", path.basename(src), "-filter_complex", `[0:v]${filter}[v]`, "-map", "[v]"];

    await runFfmpeg(
      [...args, "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", path.basename(outPath)],
      { cwd: dir },
    );
    return { ok: true, layout, localPath: path.basename(outPath), segmentStart };
  } catch (e) {
    console.warn(`Веб-ассет «${asset.title ?? asset.directUrl}»:`, String(e).slice(0, 120));
    return { ok: false };
  }
}
