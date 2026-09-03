import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { frameHash, hamming } from "./sceneHash";
import { EditPlan, EditEvent } from "./editPlan";
import { CARD, CARD_FILTER, CARD_CROP, AUTHOR_CROP } from "./topInset";

/**
 * Сверка отрендеренного ролика с планом.
 *
 * План может быть безупречным, а в готовом файле картинки не окажется. Поэтому
 * готовый файл проверяется по факту: в области карточки — строго x=90, y=120,
 * 900×506 — должен быть ожидаемый материал, а ниже — автор.
 *
 * Главное правило: каждая запланированная точка обязана получить результат.
 * Пропуск «не смогли проверить» — это не «всё хорошо»: молчаливый пропуск
 * однажды спрятал ту самую вставку, ради которой проверка и делалась.
 *
 * Всё локально: ffmpeg и арифметика, ни одного платного вызова.
 */

/** Расстояние между хэшами, ниже которого считаем «на экране тот самый материал». */
export const MATCH_DISTANCE = 18;
/** Насколько карточка может измениться внутри одной вставки: больше — это уже видео. */
export const STILL_TOLERANCE = 10;

export type CheckStatus = "PASS" | "FAIL" | "ERROR";

export type CheckPoint = {
  assetId: string;
  assetFile: string;
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
  /** контрольные секунды после вступления, где по плану карточки нет */
  gaps: { at: number }[];
  ok: boolean;
};

const isStill = (f: string) => /\.(jpe?g|png|webp|bmp)$/i.test(f);

async function grab(file: string, at: number, out: string, still: boolean, vf: string): Promise<string | null> {
  try {
    // у картинки кадр один: перемотка к нулю уводит за его пределы
    const seek = still ? [] : ["-ss", at.toFixed(3)];
    await runFfmpeg([...seek, "-i", file, "-frames:v", "1", "-vf", vf, "-q:v", "4", out]);
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
 * Проверяет, что в запланированные моменты в области карточки действительно
 * ожидаемая картинка, автор под ней виден, карточка неподвижна, а после
 * вступления она есть на каждой контрольной секунде. Результат — ПО КАЖДОЙ
 * точке, без исключений.
 */
export async function checkRenderConformance(
  dir: string,
  renderedFile: string,
  plan: EditPlan,
  opts: { introEnd?: number } = {},
): Promise<ConformanceResult> {
  const tmp = path.join(dir, "_conformance");
  fs.mkdirSync(tmp, { recursive: true });
  const inserts = plan.events.filter((e) => e.type === "B_ROLL" && e.file).sort((a, b) => a.start - b.start);
  const points: CheckPoint[] = [];
  const gaps: { at: number }[] = [];

  const fail = (base: Omit<CheckPoint, "status" | "distance">, reason: string): CheckPoint => ({
    ...base,
    distance: null,
    status: "ERROR",
    reason,
  });

  try {
    for (const [i, ev] of inserts.entries()) {
      const file = ev.file!;
      const assetId = path.basename(file).replace(/\.[a-z0-9]+$/i, "");
      const baseOf = (at: number) => ({
        assetId,
        assetFile: path.basename(file),
        plannedStart: Number(ev.start.toFixed(2)),
        plannedEnd: Number(ev.end.toFixed(2)),
        at: Number(at.toFixed(2)),
      });

      // Только картинки: видеофайл в карточке — ошибка плана, а не рендера.
      if (!isStill(file)) {
        for (const at of checkPointsFor(ev)) points.push(fail(baseOf(at), "в карточке видеофайл, а разрешены только картинки"));
        continue;
      }
      if (!fs.existsSync(file)) {
        for (const at of checkPointsFor(ev)) points.push(fail(baseOf(at), "файл материала отсутствует на диске"));
        continue;
      }

      // эталон один: сама картинка, приведённая к карточке тем же фильтром, что и в рендере
      const refFile = path.join(tmp, `ref-${i}.jpg`);
      const refErr = await grab(file, 0, refFile, true, CARD_FILTER);
      const refHash = refErr ? null : await frameHash(refFile, tmp);
      if (refErr || refHash === null) {
        for (const at of checkPointsFor(ev)) points.push(fail(baseOf(at), `эталон карточки не снят: ${refErr ?? "не разобран"}`));
        continue;
      }

      const cardHashes: bigint[] = [];
      for (const at of checkPointsFor(ev)) {
        const base = baseOf(at);
        const shot = path.join(tmp, `card-${i}-${at.toFixed(2)}.jpg`);
        const outErr = await grab(renderedFile, at, shot, false, CARD_CROP);
        if (outErr) {
          points.push(fail(base, `кадр карточки не снят: ${outErr}`));
          continue;
        }
        const outHash = await frameHash(shot, tmp);
        if (outHash === null) {
          points.push(fail(base, "кадр карточки не поддался разбору"));
          continue;
        }
        cardHashes.push(outHash);

        const distance = hamming(refHash, outHash);
        if (distance > MATCH_DISTANCE) {
          points.push({ ...base, distance, status: "FAIL", reason: "в области карточки не запланированная картинка" });
          continue;
        }

        // автор под карточкой обязан оставаться на экране
        const authorShot = path.join(tmp, `author-${i}-${at.toFixed(2)}.jpg`);
        const aErr = await grab(renderedFile, at, authorShot, false, AUTHOR_CROP);
        if (aErr) {
          points.push(fail(base, `зона автора не снята: ${aErr}`));
          continue;
        }
        const authorHash = await frameHash(authorShot, tmp);
        if (authorHash === null) {
          points.push(fail(base, "зона автора не поддалась разбору"));
          continue;
        }
        if (hamming(refHash, authorHash) <= MATCH_DISTANCE) {
          points.push({ ...base, distance, status: "FAIL", reason: "картинка занимает и зону автора — он перекрыт" });
          continue;
        }
        points.push({ ...base, distance, status: "PASS" });
      }

      // карточка неподвижна: если три её кадра заметно различаются — это видео
      if (cardHashes.length === 3) {
        const drift = Math.max(hamming(cardHashes[0], cardHashes[1]), hamming(cardHashes[1], cardHashes[2]));
        if (drift > STILL_TOLERANCE) {
          const last = points[points.length - 1];
          if (last && last.status === "PASS") {
            points[points.length - 1] = { ...last, status: "FAIL", reason: `содержимое карточки движется (дрейф ${drift})` };
          }
        }
      }
    }

    // после вступления карточка должна быть на КАЖДОЙ контрольной секунде
    const introEnd = opts.introEnd ?? inserts[0]?.start ?? plan.duration;
    for (let t = introEnd + 0.5; t < plan.duration - 0.2; t += 1) {
      if (!inserts.some((e) => e.start <= t && t <= e.end + 1 / 30)) gaps.push({ at: Number(t.toFixed(2)) });
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  const expected = inserts.length * 3;
  if (points.length !== expected) {
    points.push({
      assetId: "-",
      assetFile: "-",
      plannedStart: 0,
      plannedEnd: 0,
      at: 0,
      distance: null,
      status: "ERROR",
      reason: `проверено ${points.length} точек из ${expected} запланированных`,
    });
  }
  const passed = points.filter((p) => p.status === "PASS").length;
  const failed = points.filter((p) => p.status === "FAIL").length;
  const errored = points.filter((p) => p.status === "ERROR").length;
  return {
    expected,
    points,
    passed,
    failed,
    errored,
    gaps,
    ok: passed === expected && failed === 0 && errored === 0 && gaps.length === 0,
  };
}

export { CARD };
