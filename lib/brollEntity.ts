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
): Promise<{ ok: boolean; layout?: Layout; localPath?: string }> {
  const dir = path.dirname(outPath);
  const base = path.basename(outPath, ".mp4");
  const ext = asset.mediaType === "video" ? ".src" : path.extname(new URL(asset.directUrl).pathname) || ".jpg";
  const src = path.join(dir, `web-${base}${ext}`);

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

    const args =
      asset.mediaType === "video"
        ? ["-i", path.basename(src), "-t", dur, "-an", "-filter_complex", `[0:v]${filter}[v]`, "-map", "[v]"]
        : ["-loop", "1", "-t", dur, "-i", path.basename(src), "-filter_complex", `[0:v]${filter}[v]`, "-map", "[v]"];

    await runFfmpeg(
      [...args, "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", path.basename(outPath)],
      { cwd: dir },
    );
    return { ok: true, layout, localPath: path.basename(outPath) };
  } catch (e) {
    console.warn(`Веб-ассет «${asset.title ?? asset.directUrl}»:`, String(e).slice(0, 120));
    return { ok: false };
  }
}
