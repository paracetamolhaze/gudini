import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { frameHash, hamming } from "./sceneHash";
import { EditPlan } from "./editPlan";

/**
 * Сверка отрендеренного ролика с планом.
 *
 * План может быть безупречным, а в готовом файле вставки не окажется: так фото
 * на 43.9–47.4 существовало в плане и отсутствовало в MP4 целых три секунды,
 * и ни одна проверка этого не заметила — техническая самопроверка смотрит на
 * длительность и потоки, а не на то, ЧТО видно на экране.
 *
 * Здесь кадры готового файла сравниваются с исходным материалом по
 * перцептивному хэшу. Всё локально: ffmpeg и арифметика, ни одного платного вызова.
 */

/** Совпадение хэшей ниже этого расстояния считаем «это тот самый материал». */
export const MATCH_DISTANCE = 18;

export type ConformanceIssue = {
  at: number;
  assetFile: string;
  expected: "EXTERNAL_VIDEO" | "EXTERNAL_IMAGE";
  distance: number;
  reason: string;
};

export type ConformanceResult = {
  checked: number;
  matched: number;
  issues: ConformanceIssue[];
  ok: boolean;
};

/**
 * Снимает кадр из файла в заданной секунде.
 *
 * У неподвижной картинки кадр ровно один, и перемотка к нулю уводит за его
 * пределы: ffmpeg отдаёт «frame=0» и пустой файл. Поэтому для картинок
 * перемотки нет вовсе — это та же причина, по которой фото пропало из ролика.
 */
async function grab(file: string, at: number, out: string, cwd: string, still = false): Promise<boolean> {
  try {
    const args = still
      ? ["-i", file, "-frames:v", "1", "-q:v", "4", out]
      : ["-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "4", out];
    await runFfmpeg(args, { cwd });
    return fs.existsSync(out) && fs.statSync(out).size > 0;
  } catch {
    return false;
  }
}

/**
 * Для каждой запланированной вставки проверяет три момента: начало, середину
 * и конец. Если в эти секунды на экране не материал вставки, а лицо автора —
 * план и результат разошлись, и это жёсткая ошибка, а не замечание.
 */
export async function checkRenderConformance(
  dir: string,
  renderedFile: string,
  plan: EditPlan,
): Promise<ConformanceResult> {
  const tmp = path.join(dir, "_conformance");
  fs.mkdirSync(tmp, { recursive: true });
  const issues: ConformanceIssue[] = [];
  let checked = 0;
  let matched = 0;

  try {
    for (const [i, ev] of plan.events.filter((e) => e.type === "B_ROLL" && e.file).entries()) {
      const assetPath = ev.file!;
      if (!fs.existsSync(assetPath)) {
        issues.push({
          at: ev.start,
          assetFile: path.basename(assetPath),
          expected: "EXTERNAL_VIDEO",
          distance: -1,
          reason: "файл материала отсутствует на диске",
        });
        continue;
      }
      const isStill = /\.(jpe?g|png|webp|bmp|gif)$/i.test(assetPath);
      const expected = isStill ? "EXTERNAL_IMAGE" : "EXTERNAL_VIDEO";

      const points = [ev.start + 0.15, (ev.start + ev.end) / 2, ev.end - 0.15];
      for (const at of points) {
        // Эталон берётся в ТОМ ЖЕ месте материала, что показано на экране:
        // сегмент движется, и кадр на 0.3с не похож на кадр на 2.5с даже внутри
        // одной вставки. Сравнение с фиксированной точкой давало ложные расхождения.
        const offset = isStill ? 0 : Math.max(0, at - ev.start);
        const refFile = path.join(tmp, `ref-${i}-${offset.toFixed(2)}.jpg`);
        checked++;

        // Невозможность проверить точку — это не «всё в порядке». Молчаливый
        // пропуск однажды уже спрятал ровно ту вставку, ради которой всё затевалось.
        if (!(await grab(assetPath, offset, refFile, dir, isStill))) {
          issues.push({ at: Number(at.toFixed(2)), assetFile: path.basename(assetPath), expected, distance: -1,
            reason: "не удалось снять эталонный кадр материала" });
          continue;
        }
        const refHash = await frameHash(refFile, tmp);
        try {
          fs.rmSync(refFile, { force: true });
        } catch {}
        if (refHash === null) {
          issues.push({ at: Number(at.toFixed(2)), assetFile: path.basename(assetPath), expected, distance: -1,
            reason: "эталонный кадр не поддался разбору" });
          continue;
        }

        const shot = path.join(tmp, `out-${i}-${at.toFixed(2)}.jpg`);
        if (!(await grab(renderedFile, at, shot, dir))) {
          issues.push({ at: Number(at.toFixed(2)), assetFile: path.basename(assetPath), expected, distance: -1,
            reason: "не удалось снять кадр готового ролика" });
          continue;
        }
        const outHash = await frameHash(shot, tmp);
        if (outHash === null) {
          issues.push({ at: Number(at.toFixed(2)), assetFile: path.basename(assetPath), expected, distance: -1,
            reason: "кадр готового ролика не поддался разбору" });
          continue;
        }
        const distance = hamming(refHash, outHash);
        if (distance <= MATCH_DISTANCE) {
          matched++;
        } else {
          issues.push({
            at: Number(at.toFixed(2)),
            assetFile: path.basename(assetPath),
            expected,
            distance,
            reason: "в этот момент на экране не запланированный материал",
          });
        }
        try {
          fs.rmSync(shot, { force: true });
        } catch {}
      }
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  return { checked, matched, issues, ok: issues.length === 0 };
}
