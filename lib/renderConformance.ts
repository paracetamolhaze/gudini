import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { frameHash, hamming } from "./sceneHash";
import { EditPlan, EditEvent } from "./editPlan";

/**
 * Сверка отрендеренного ролика с планом.
 *
 * План может быть безупречным, а в готовом файле вставки не окажется: фото на
 * 43.9–47.4 существовало в плане и отсутствовало в MP4 три секунды подряд.
 * Техническая самопроверка этого не видит — она смотрит на длительность и
 * потоки, а не на то, ЧТО на экране.
 *
 * Главное правило: каждая запланированная точка обязана получить результат.
 * Пропуск «не смогли проверить» — это не «всё хорошо»: именно молчаливый пропуск
 * однажды спрятал ту самую вставку, ради которой проверка и делалась.
 *
 * Всё локально: ffmpeg и арифметика, ни одного платного вызова.
 */

/** Расстояние между хэшами, ниже которого считаем «на экране тот самый материал». */
export const MATCH_DISTANCE = 18;

/** Кадр приводится к тому же виду, в каком он попадает в ролик. */
const LAYOUT = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";

export type CheckStatus = "PASS" | "FAIL" | "ERROR";

export type CheckPoint = {
  assetId: string;
  assetFile: string;
  kind: "EXTERNAL_IMAGE" | "EXTERNAL_VIDEO";
  plannedStart: number;
  plannedEnd: number;
  at: number;
  distance: number | null;
  status: CheckStatus;
  reason?: string;
};

export type ConformanceResult = {
  expected: number;
  points: CheckPoint[];
  passed: number;
  failed: number;
  errored: number;
  ok: boolean;
};

const isStill = (f: string) => /\.(jpe?g|png|webp|bmp|gif)$/i.test(f);

/**
 * Снимает кадр и приводит его к монтажному виду.
 *
 * У неподвижной картинки кадр ровно один, и перемотка к нулю уводит за его
 * пределы: ffmpeg отдаёт «frame=0» и пустой файл. Поэтому для картинок
 * перемотки нет — это та же причина, по которой фото пропадало из ролика.
 */
async function grab(file: string, at: number, out: string, still: boolean): Promise<string | null> {
  try {
    const seek = still ? [] : ["-ss", at.toFixed(3)];
    await runFfmpeg([...seek, "-i", file, "-frames:v", "1", "-vf", LAYOUT, "-q:v", "4", out]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return "ffmpeg не создал кадр";
    return null;
  } catch (e: any) {
    return String(e?.message ?? e).slice(0, 120);
  }
}

/** Три момента внутри вставки: начало, середина, конец. */
export function checkPointsFor(ev: EditEvent): number[] {
  return [ev.start + 0.15, (ev.start + ev.end) / 2, ev.end - 0.15];
}

/**
 * Проверяет, что в запланированные моменты на экране действительно материал
 * вставки. Возвращает результат ПО КАЖДОЙ точке — без исключений.
 */
export async function checkRenderConformance(
  dir: string,
  renderedFile: string,
  plan: EditPlan,
): Promise<ConformanceResult> {
  const tmp = path.join(dir, "_conformance");
  fs.mkdirSync(tmp, { recursive: true });
  const inserts = plan.events.filter((e) => e.type === "B_ROLL" && e.file);
  const points: CheckPoint[] = [];

  const fail = (base: Omit<CheckPoint, "status" | "distance">, reason: string): CheckPoint => ({
    ...base,
    distance: null,
    status: "ERROR",
    reason,
  });

  try {
    for (const [i, ev] of inserts.entries()) {
      const file = ev.file!;
      const still = isStill(file);
      const kind = still ? "EXTERNAL_IMAGE" : "EXTERNAL_VIDEO";
      const assetId = path.basename(file).replace(/\.[a-z0-9]+$/i, "");

      // Для картинки эталон один — она сама, приведённая к монтажному виду.
      // Для видео эталон свой на каждую точку: сегмент движется, и кадр на 0.3с
      // не похож на кадр на 2.5с даже внутри одной вставки.
      let stillRefHash: bigint | null = null;
      let stillRefError: string | null = null;
      if (still) {
        const refFile = path.join(tmp, `ref-${i}.jpg`);
        const err = await grab(file, 0, refFile, true);
        if (err) stillRefError = `эталон изображения не снят: ${err}`;
        else {
          stillRefHash = await frameHash(refFile, tmp);
          if (stillRefHash === null) stillRefError = "эталон изображения не поддался разбору";
        }
      }

      for (const at of checkPointsFor(ev)) {
        const base = {
          assetId,
          assetFile: path.basename(file),
          kind: kind as CheckPoint["kind"],
          plannedStart: Number(ev.start.toFixed(2)),
          plannedEnd: Number(ev.end.toFixed(2)),
          at: Number(at.toFixed(2)),
        };

        if (!fs.existsSync(file)) {
          points.push(fail(base, "файл материала отсутствует на диске"));
          continue;
        }

        let refHash = stillRefHash;
        if (!still) {
          const offset = Math.max(0, at - ev.start);
          const refFile = path.join(tmp, `ref-${i}-${offset.toFixed(2)}.jpg`);
          const err = await grab(file, offset, refFile, false);
          if (err) {
            points.push(fail(base, `эталонный кадр материала не снят: ${err}`));
            continue;
          }
          refHash = await frameHash(refFile, tmp);
          if (refHash === null) {
            points.push(fail(base, "эталонный кадр не поддался разбору"));
            continue;
          }
        } else if (stillRefError) {
          points.push(fail(base, stillRefError));
          continue;
        }

        const shot = path.join(tmp, `out-${i}-${at.toFixed(2)}.jpg`);
        const outErr = await grab(renderedFile, at, shot, false);
        if (outErr) {
          points.push(fail(base, `кадр готового ролика не снят: ${outErr}`));
          continue;
        }
        const outHash = await frameHash(shot, tmp);
        if (outHash === null) {
          points.push(fail(base, "кадр готового ролика не поддался разбору"));
          continue;
        }

        const distance = hamming(refHash!, outHash);
        points.push({
          ...base,
          distance,
          status: distance <= MATCH_DISTANCE ? "PASS" : "FAIL",
          reason: distance <= MATCH_DISTANCE ? undefined : "на экране не запланированный материал",
        });
      }
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  const expected = inserts.length * 3;
  const passed = points.filter((p) => p.status === "PASS").length;
  const failed = points.filter((p) => p.status === "FAIL").length;
  const errored = points.filter((p) => p.status === "ERROR").length;

  // Недосчитанная точка — тоже провал: отчёт обязан покрыть все запланированные.
  if (points.length !== expected) {
    points.push({
      assetId: "-",
      assetFile: "-",
      kind: "EXTERNAL_VIDEO",
      plannedStart: 0,
      plannedEnd: 0,
      at: 0,
      distance: null,
      status: "ERROR",
      reason: `проверено ${points.length} точек из ${expected} запланированных`,
    });
  }

  return {
    expected,
    points,
    passed,
    failed,
    errored: points.filter((p) => p.status === "ERROR").length,
    ok: passed === expected && failed === 0 && errored === 0,
  };
}
