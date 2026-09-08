import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { CharacterProfile } from "./types";

/**
 * Постоянный персонаж (Character Bible + Character Reference Pack).
 *
 * Профиль лежит в `assets/ai-film/characters/<id>/character.json`, эталонные картинки —
 * рядом (любые png/jpg/webp, до трёх, по алфавиту, либо список `referenceImages` в
 * профиле). Identity персонажа не генерируется моделью и не меняется от проекта к
 * проекту; Claude описывает только его роль в конкретной истории. Хэш эталонов входит
 * в ключ кэша сцен: другие картинки — другие сцены.
 */

export const DEFAULT_CHARACTER_ID = "gudini";
export const MAX_REFERENCE_IMAGES = 3;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export function characterId(): string {
  return (process.env.AI_FILM_CHARACTER_ID || DEFAULT_CHARACTER_ID).trim();
}

export function charactersDir(): string {
  const v = process.env.AI_FILM_CHARACTER_DIR;
  return v ? path.resolve(v) : path.join(process.cwd(), "assets", "ai-film", "characters");
}

export function referenceHash(files: string[]): string {
  const h = crypto.createHash("sha1");
  for (const f of files) {
    h.update(path.basename(f));
    h.update(fs.readFileSync(f));
  }
  return files.length ? h.digest("hex").slice(0, 16) : "no-refs";
}

const s = (v: unknown, field: string, file: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Профиль персонажа ${file}: нет поля «${field}»`);
  return v.trim();
};

/** Загрузка профиля из папки. Без профиля AI-фильм не собирается — это ошибка настройки, не «пустой герой». */
export function loadCharacterProfile(id = characterId(), baseDir = charactersDir()): CharacterProfile {
  const dir = path.join(baseDir, id);
  const file = path.join(dir, "character.json");
  if (!fs.existsSync(file)) {
    throw new Error(`AI-фильм: нет профиля персонажа «${id}» (${file}). Создайте character.json и положите рядом эталонные картинки`);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`Профиль персонажа ${file}: не JSON (${e?.message ?? e})`);
  }
  const listed: string[] = Array.isArray(raw.referenceImages) ? raw.referenceImages.map(String) : [];
  const discovered = fs
    .readdirSync(dir)
    .filter((f) => IMAGE_RE.test(f))
    .sort();
  const names = (listed.length ? listed : discovered).filter((f) => fs.existsSync(path.join(dir, f))).slice(0, MAX_REFERENCE_IMAGES);
  const referenceFiles = names.map((f) => path.join(dir, f));
  return {
    id: s(raw.id ?? id, "id", file),
    name: s(raw.name, "name", file),
    role: "main_protagonist",
    description: s(raw.description, "description", file),
    appearance: s(raw.appearance, "appearance", file),
    clothes: s(raw.clothes, "clothes", file),
    signature: s(raw.signature, "signature", file),
    styleLock: s(raw.styleLock, "styleLock", file),
    world: s(raw.world, "world", file),
    negative: typeof raw.negative === "string" ? raw.negative.trim() : undefined,
    referenceImages: names,
    referenceFiles,
    refHash: referenceHash(referenceFiles),
    dir,
  };
}

/** Блок описания персонажа для промптов Veo и для сценариста. */
export function characterBlock(c: CharacterProfile): string {
  return (
    `Main character ${c.name.toUpperCase()} (the same person in every shot, must match the reference images): ` +
    `${c.description}. Appearance: ${c.appearance}. Clothes: ${c.clothes}. Always visible: ${c.signature}.`
  );
}

export function mimeFor(file: string): string {
  return /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
}
