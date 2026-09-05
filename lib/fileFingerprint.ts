import fs from "fs";
import crypto from "crypto";

const SAMPLE = 4 * 1024 * 1024;

/**
 * Отпечаток содержимого файла без чтения его целиком: размер плюс sha1 первых и
 * последних 4 МБ. Ключи кэша (расшифровка, план чистки, скачанный исходник) раньше
 * опирались на один размер, и новый файл той же длины получал чужие данные.
 */
export function fileFingerprint(file: string): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const hash = crypto.createHash("sha1");
    const head = Buffer.alloc(Math.min(SAMPLE, size));
    fs.readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (size > SAMPLE) {
      const tail = Buffer.alloc(Math.min(SAMPLE, size - SAMPLE));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
    return `${size}-${hash.digest("hex").slice(0, 16)}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** Короткий хэш текста (сценарий) для ключей кэша. */
export function textHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}
