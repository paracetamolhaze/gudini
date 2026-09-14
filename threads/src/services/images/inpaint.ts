import sharp from "sharp";
import type { PlacedBlock } from "./schemas.js";

/**
 * Remove the original text in the translated blocks only. Each box is filled with a colour
 * interpolated from its own border (median of the left/right edge per row), which follows flat
 * fills and horizontal gradients — the common cases for infographics and screenshots.
 * Brand marks, watermarks and untranslated blocks are never touched.
 */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function toPixels(b: { x: number; y: number; w: number; h: number }, width: number, height: number, pad = 0.12): PixelBox {
  const px = (b.x / 1000) * width;
  const py = (b.y / 1000) * height;
  const pw = (b.w / 1000) * width;
  const ph = (b.h / 1000) * height;
  const padY = ph * pad;
  const padX = Math.max(2, ph * pad * 0.6);
  const x = Math.max(0, Math.floor(px - padX));
  const y = Math.max(0, Math.floor(py - padY));
  const w = Math.min(width - x, Math.ceil(pw + padX * 2));
  const h = Math.min(height - y, Math.ceil(ph + padY * 2));
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function fillPatch(image: sharp.Sharp, box: PixelBox): Promise<Buffer> {
  const ring = 3;
  const region = { left: Math.max(0, box.x - ring), top: Math.max(0, box.y - ring), width: box.w + ring * 2, height: box.h + ring * 2 };
  const meta = await image.metadata();
  const W = meta.width ?? region.width;
  const H = meta.height ?? region.height;
  region.width = Math.min(region.width, W - region.left);
  region.height = Math.min(region.height, H - region.top);
  const { data, info } = await image.clone().extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const at = (x: number, y: number, c: number) => data[(y * info.width + x) * ch + c]!;
  const rows: Array<[number, number, number, number, number, number]> = [];
  for (let y = 0; y < info.height; y++) {
    const left = [0, 1, 2].map((c) => median([0, 1, 2].filter((x) => x < info.width).map((x) => at(x, y, c)))) as [number, number, number];
    const right = [0, 1, 2].map((c) => median([info.width - 1, info.width - 2, info.width - 3].filter((x) => x >= 0).map((x) => at(x, y, c)))) as [number, number, number];
    rows.push([left[0], left[1], left[2], right[0], right[1], right[2]]);
  }
  // Also blend with the top/bottom edge medians so vertical gradients do not band.
  const top = [0, 1, 2].map((c) => median(Array.from({ length: info.width }, (_, x) => at(x, 0, c))));
  const bottom = [0, 1, 2].map((c) => median(Array.from({ length: info.width }, (_, x) => at(x, info.height - 1, c))));
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let y = 0; y < info.height; y++) {
    const r = rows[y]!;
    const ty = info.height > 1 ? y / (info.height - 1) : 0;
    for (let x = 0; x < info.width; x++) {
      const tx = info.width > 1 ? x / (info.width - 1) : 0;
      for (let c = 0; c < 3; c++) {
        const horiz = r[c]! * (1 - tx) + r[c + 3]! * tx;
        const vert = top[c]! * (1 - ty) + bottom[c]! * ty;
        out[(y * info.width + x) * 3 + c] = Math.round(horiz * 0.7 + vert * 0.3);
      }
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
    .blur(1.2)
    .png()
    .toBuffer();
}

export async function inpaintBlocks(input: Buffer, blocks: PlacedBlock[], width: number, height: number): Promise<Buffer> {
  const base = sharp(input, { failOn: "none" }).rotate();
  const composites: sharp.OverlayOptions[] = [];
  for (const b of blocks) {
    if (!b.translate) continue;
    const box = toPixels(b.bbox, width, height);
    const patch = await fillPatch(base, box);
    composites.push({ input: patch, left: Math.max(0, box.x - 3), top: Math.max(0, box.y - 3) });
  }
  if (!composites.length) return base.png().toBuffer();
  return base.composite(composites).png().toBuffer();
}
