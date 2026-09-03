import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";

/**
 * Чёрные полосы внутри картинки.
 *
 * Карточка приводится к 16:9 обрезкой, но если исходник САМ содержит вертикальное
 * видео в чёрной рамке (так выкладывают телефонные съёмки), обрезка полосы не
 * убирает — они часть изображения. В готовом ролике такие карточки выглядели
 * как узкий кадр между двумя чёрными столбами, и ни одна проверка это не ловила.
 *
 * Проверка локальная: кадр уменьшается до сетки 90×50 в градациях серого, и
 * сравнивается яркость крайних полос с центром. Денег не стоит.
 */

const W = 90;
const H = 50;
/** Полоса считается чёрной, если её средняя яркость ниже этого порога (0–255). */
const BAR_MAX = 22;
/** А центр при этом должен быть заметно светлее — иначе это просто тёмный кадр. */
const CENTER_MIN = 45;

export type BarReport = { left: number; right: number; top: number; bottom: number; center: number; hasBars: boolean };

function mean(buf: Buffer, xs: [number, number], ys: [number, number]): number {
  let sum = 0;
  let n = 0;
  for (let y = ys[0]; y < ys[1]; y++) {
    for (let x = xs[0]; x < xs[1]; x++) {
      sum += buf[y * W + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

export async function blackBarReport(file: string, tmpDir: string): Promise<BarReport> {
  const raw = path.join(tmpDir, `bars-${path.basename(file)}.gray`);
  try {
    await runFfmpeg(["-i", file, "-frames:v", "1", "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const buf = fs.readFileSync(raw);
    if (buf.length < W * H) throw new Error("кадр не прочитан");
    const left = mean(buf, [0, 7], [0, H]);
    const right = mean(buf, [W - 7, W], [0, H]);
    const top = mean(buf, [0, W], [0, 4]);
    const bottom = mean(buf, [0, W], [H - 4, H]);
    const center = mean(buf, [25, W - 25], [12, H - 12]);
    // Полоса и с одной стороны — дефект: телефонная съёмка в рамке бывает
    // прижата к краю, и в готовом ролике справа стоял чёрный столб при светлом
    // левом крае. Кромка темнее порога при заметно светлом центре — это полоса.
    const edgeDark = Math.min(left, right, top, bottom) < BAR_MAX;
    return { left, right, top, bottom, center, hasBars: edgeDark && center > CENTER_MIN };
  } finally {
    try {
      fs.rmSync(raw, { force: true });
    } catch {}
  }
}

export async function hasBlackBars(file: string, tmpDir: string): Promise<boolean> {
  return (await blackBarReport(file, tmpDir)).hasBars;
}
