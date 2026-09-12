import { IG_LIMITS } from "./limits";

/** Размер JPEG из маркера SOF — без декодера. null — не JPEG или файл обрезан. */
export function jpegInfo(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = buf.readUInt16BE(i + 2);
    if (SOF.has(marker)) {
      if (i + 8 >= buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Что Instagram не примет в этом файле; пустой список — картинка годится для карусели. */
export function instagramImageProblems(buf: Buffer): string[] {
  const info = jpegInfo(buf);
  if (!info) return ["файл не JPEG"];
  const p: string[] = [];
  if (buf.length > IG_LIMITS.imageMaxBytes) p.push(`размер ${(buf.length / 1048576).toFixed(1)} МБ больше 8 МБ`);
  if (info.width < IG_LIMITS.minWidth || info.width > IG_LIMITS.maxWidth) p.push(`ширина ${info.width} вне 320–1440`);
  const aspect = info.width / info.height;
  if (aspect < IG_LIMITS.minAspect - 1e-6 || aspect > IG_LIMITS.maxAspect + 1e-6) p.push(`соотношение ${info.width}×${info.height} вне 4:5…1.91:1`);
  return p;
}
