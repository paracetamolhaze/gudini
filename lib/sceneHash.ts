import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";

/**
 * Перцептивный хэш кадра и группировка почти одинаковых сцен.
 *
 * Из одного сюжета можно нарезать десять фрагментов, и формально это десять
 * разных материалов — но если восемь из них показывают один и тот же план
 * с той же точки, ценность медиатеки не в десять раз больше, а примерно втрое.
 * Считаем это локально: ffmpeg и арифметика денег не стоят.
 *
 * Разные полезные моменты одного видео (празднование, травма, помощь врачей,
 * носилки) отличаются достаточно, чтобы попасть в разные сцены.
 */

/** Порог различия для «это тот же план»: из 64 бит хэша. */
export const SAME_SCENE_DISTANCE = 12;

/**
 * dHash: кадр сжимается до 9×8 в оттенках серого, каждый бит — «следующий пиксель
 * ярче предыдущего». Устойчив к сжатию, размытию и смене яркости, чувствителен
 * к смене плана.
 */
export async function frameHash(file: string, tmpDir: string): Promise<bigint | null> {
  const raw = path.join(tmpDir, `hash-${path.basename(file)}.gray`);
  try {
    await runFfmpeg([
      "-i", file,
      "-frames:v", "1",
      "-vf", "scale=9:8,format=gray",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      raw,
    ]);
    const buf = fs.readFileSync(raw);
    if (buf.length < 72) return null;
    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = buf[row * 9 + col];
        const right = buf[row * 9 + col + 1];
        hash = (hash << 1n) | (right > left ? 1n : 0n);
      }
    }
    return hash;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(raw, { force: true });
    } catch {}
  }
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Раскладывает хэши по сценам. Возвращает для каждого кадра номер его сцены:
 * кадры одной сцены визуально почти неразличимы.
 */
export function groupScenes(hashes: (bigint | null)[], threshold = SAME_SCENE_DISTANCE): number[] {
  const reps: bigint[] = [];
  return hashes.map((h) => {
    if (h === null) {
      reps.push(0n);
      return reps.length - 1; // кадр без хэша считаем отдельной сценой, а не сливаем со всеми
    }
    const found = reps.findIndex((r) => r !== 0n && hamming(r, h) <= threshold);
    if (found >= 0) return found;
    reps.push(h);
    return reps.length - 1;
  });
}
