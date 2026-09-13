import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { DesignSettings } from "./types";
import { DEFAULT_DESIGN, DESIGN_LIMITS, mergeDesign } from "./designShared";
import { CarouselError, carouselsRoot, withFileLock, writeFileAtomic } from "./store";
import { extensionFor, imageDimensions, sniffImage } from "./imageFile";

/**
 * Оформление аккаунта на сервере: data/carousels/design.json и файлы логотипа и референса в
 * data/carousels/brand/. Старые файлы бренда не удаляются: карусели хранят копию оформления
 * со ссылкой на свой файл, и замена логотипа не ломает уже собранные карусели.
 */

const designFile = () => path.join(carouselsRoot(), "design.json");
export const brandDir = () => path.join(carouselsRoot(), "brand");
const BRAND_FILE_RE = /^(logo|reference)-[a-f0-9]{16}\.(png|jpg|webp)$/;

export const isBrandFile = (v: unknown): v is string => typeof v === "string" && BRAND_FILE_RE.test(v);

export function brandFilePath(file: string): string {
  if (!isBrandFile(file)) throw new CarouselError("Недопустимое имя файла оформления", 400, "bad_file");
  return path.join(brandDir(), file);
}

export function readDesign(): DesignSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(designFile(), "utf8"));
    const merged = mergeDesign(DEFAULT_DESIGN, raw ?? {});
    const design = "design" in merged ? merged.design : { ...DEFAULT_DESIGN };
    if (isBrandFile(raw?.logoFile) && fs.existsSync(brandFilePath(raw.logoFile))) design.logoFile = raw.logoFile;
    if (isBrandFile(raw?.referenceFile) && fs.existsSync(brandFilePath(raw.referenceFile))) design.referenceFile = raw.referenceFile;
    if (typeof raw?.updatedAt === "string") design.updatedAt = raw.updatedAt;
    return design;
  } catch {
    return { ...DEFAULT_DESIGN };
  }
}

function writeDesign(design: DesignSettings): DesignSettings {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  const next = { ...design, updatedAt: new Date().toISOString() };
  writeFileAtomic(designFile(), JSON.stringify(next, null, 2));
  return next;
}

export function updateDesign(patch: Record<string, unknown>): DesignSettings {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  return withFileLock(designFile(), () => {
    const merged = mergeDesign(readDesign(), patch);
    if ("error" in merged) throw new CarouselError(merged.error, 400, "bad_design");
    return writeDesign(merged.design);
  });
}

/** Логотип или референс: только PNG, JPEG или WebP по сигнатуре, с пределом размера. */
export function saveBrandAsset(kind: "logo" | "reference", buffer: Buffer): DesignSettings {
  const mime = sniffImage(buffer);
  if (!mime) throw new CarouselError("Нужна картинка PNG, JPEG или WebP", 400, "bad_image");
  const max = kind === "logo" ? DESIGN_LIMITS.logoMaxBytes : DESIGN_LIMITS.referenceMaxBytes;
  if (buffer.length > max) throw new CarouselError(`Файл больше ${Math.round(max / 1024 / 1024)} МБ`, 413, "too_large");
  const dims = imageDimensions(buffer);
  if (!dims || dims.width < 64 || dims.height < 64 || dims.width > 8192 || dims.height > 8192) {
    throw new CarouselError("Картинка должна быть от 64 до 8192 пикселей по каждой стороне", 400, "bad_image");
  }
  const file = `${kind}-${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16)}.${extensionFor(mime)}`;
  fs.mkdirSync(brandDir(), { recursive: true });
  const full = brandFilePath(file);
  if (!fs.existsSync(full)) writeFileAtomic(full, buffer);
  return withFileLock(designFile(), () => writeDesign({ ...readDesign(), [kind === "logo" ? "logoFile" : "referenceFile"]: file }));
}

export function clearBrandAsset(kind: "logo" | "reference"): DesignSettings {
  fs.mkdirSync(carouselsRoot(), { recursive: true });
  return withFileLock(designFile(), () => {
    const d = readDesign();
    if (kind === "logo") delete d.logoFile;
    else delete d.referenceFile;
    return writeDesign(d);
  });
}

export function readBrandFile(file: string | undefined): Buffer | null {
  if (!isBrandFile(file)) return null;
  try {
    return fs.readFileSync(brandFilePath(file));
  } catch {
    return null;
  }
}
