import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { resolveCoverFontFile } from "./coverLayout";

/**
 * Визуалы для КОНКРЕТНЫХ сущностей — то, чего не даёт обычный сток.
 * 1) PERSON — фотография человека с Wikimedia Commons (свободная лицензия).
 * 2) TEAM_MATCHUP / GRAPHIC — собственная motion-графика («АНГЛИЯ vs МЕКСИКА»).
 * Если подходящего материала нет, мы НЕ подставляем случайный кадр по теме:
 * событие уходит в A-roll, лицо автора лучше нерелевантной перебивки.
 */

const FREE_LICENSES = /^(cc0|cc by|cc by-sa|public domain|pd|attribution)/i;

type CommonsImage = { url: string; license: string; title: string };

/** Ищет свободно лицензированное фото человека на Wikimedia Commons. */
export async function findCommonsImage(entityName: string): Promise<CommonsImage | null> {
  const query = entityName.trim();
  if (!query) return null;
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "10");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|size");
  url.searchParams.set("iiurlwidth", "1200");

  const res = await fetch(url, { headers: { "User-Agent": "Gudini/1.0 (video editor)" } });
  if (!res.ok) return null;
  const json: any = await res.json();
  const pages: any[] = Object.values(json.query?.pages ?? {});
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const license = String(info.extmetadata?.LicenseShortName?.value ?? "").replace(/<[^>]+>/g, "");
    if (!FREE_LICENSES.test(license)) continue;
    const title = String(page.title ?? "").toLowerCase();
    // имя должно встречаться в названии файла — иначе это «что-то по теме», а не человек
    const hits = terms.filter((t) => title.includes(t)).length;
    if (!terms.length || hits < terms.length) continue;
    const link = info.thumburl || info.url;
    if (!link) continue;
    return { url: String(link), license, title: String(page.title) };
  }
  return null;
}

/** Скачивает фото сущности и превращает в вертикальный клип нужной длины. */
export async function buildPersonClip(
  entityName: string,
  outPath: string,
  duration: number,
): Promise<{ ok: boolean; source?: string; license?: string }> {
  const image = await findCommonsImage(entityName);
  if (!image) return { ok: false };
  const download = await fetch(image.url, { headers: { "User-Agent": "Gudini/1.0 (video editor)" } });
  if (!download.ok) return { ok: false };
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.length < 10_000) return { ok: false };

  const dir = path.dirname(outPath);
  const still = path.join(dir, `entity-${path.basename(outPath, ".mp4")}.jpg`);
  fs.writeFileSync(still, buffer);
  await runFfmpeg(
    [
      "-loop", "1",
      "-t", Math.max(2, duration).toFixed(2),
      "-i", path.basename(still),
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
      "-r", "30",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      path.basename(outPath),
    ],
    { cwd: dir },
  );
  return { ok: true, source: image.title, license: image.license };
}

/**
 * Собственная графика вместо случайного стока: крупные строки на тёмном фоне.
 * Для «Англия vs Мексика» это честнее и понятнее, чем произвольный стадион.
 */
export async function buildGraphicClip(lines: string[], outPath: string, duration: number): Promise<boolean> {
  const clean = lines.map((l) => l.replace(/[':\\%]/g, "").trim().toUpperCase()).filter(Boolean).slice(0, 4);
  if (!clean.length) return false;

  const dir = path.dirname(outPath);
  const font = resolveCoverFontFile();
  const fontFile = path.join(dir, "graphic-font.ttf");
  fs.copyFileSync(font.file, fontFile);
  const fontArg = "graphic-font.ttf";

  const step = 260;
  const startY = 960 - ((clean.length - 1) * step) / 2;
  const draws = clean.map((text, i) => {
    const accent = clean.length > 1 && text === "VS";
    const size = accent ? 110 : 150;
    const color = accent ? "0xFFD700" : "white";
    return (
      `drawtext=fontfile=${fontArg}:text='${text}':fontsize=${size}:fontcolor=${color}` +
      `:borderw=8:bordercolor=black:x=(w-text_w)/2:y=${Math.round(startY + i * step)}-text_h/2`
    );
  });

  await runFfmpeg(
    [
      "-f", "lavfi",
      "-i", `color=c=0x0B0E14:s=1080x1920:d=${Math.max(2, duration).toFixed(2)}:r=30`,
      "-vf", draws.join(","),
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264",
      "-preset", "veryfast",
      path.basename(outPath),
    ],
    { cwd: dir },
  );
  return true;
}
