import { jpegInfo } from "./jpeg";

/** Тип и размер картинки по байтам — без декодера и без доверия к присланному media_type. */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export function sniffImage(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function extensionFor(mime: ImageMime): "png" | "jpg" | "webp" {
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
}

export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  const mime = sniffImage(buf);
  if (mime === "image/png") {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") return jpegInfo(buf);
  if (mime === "image/webp") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export function dataUrl(buf: Buffer): string {
  const mime = sniffImage(buf) ?? "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
