import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runFfmpeg } from "../lib/ffmpeg";
import { renderPlan } from "../lib/pipeline";
import { checkRenderConformance } from "../lib/renderConformance";
import { DEFAULT_CAPTION_STYLE, EditPlan } from "../lib/editPlan";

/**
 * Регрессия на настоящем рендере: неподвижная картинка обязана быть на экране
 * всю запланированную длительность. Раньше она показывалась 1/30 секунды,
 * и ни одна проверка этого не замечала. Всё локально, без единого API-вызова.
 */

test("1: запланированное изображение присутствует все свои секунды", { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-render-"));
  try {
    // цветной «A-roll» со звуком и заметно другая картинка-вставка
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=6:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-shortest",
      path.join(dir, "aroll.mp4"),
    ]);
    await runFfmpeg([
      "-f", "lavfi", "-i", "smptebars=s=1080x1920", "-frames:v", "1",
      path.join(dir, "still.png"),
    ]);
    fs.writeFileSync(path.join(dir, "subs.ass"), "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    const plan: EditPlan = {
      version: 1,
      duration: 6,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", start: 2, end: 5, file: path.join(dir, "still.png") }],
    };

    await renderPlan(dir, path.join(dir, "aroll.mp4"), plan, 6, () => {});
    const out = path.join(dir, "out.mp4");
    assert.ok(fs.existsSync(out), "рендер создал файл");

    // картинка должна быть видна и в начале, и в середине, и в конце вставки
    for (const at of [2.2, 3.5, 4.8]) {
      const shot = path.join(dir, `p-${at}.png`);
      await runFfmpeg(["-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=2:2", shot]);
      const px = fs.readFileSync(shot);
      assert.ok(px.length > 0, `кадр на ${at}с снят`);
    }

    // и то же самое — формальной сверкой плана с результатом
    const conf = await checkRenderConformance(dir, out, plan);
    assert.equal(conf.checked, 3, "проверены все три точки вставки");
    assert.deepEqual(conf.issues, [], "изображение присутствует на всех точках");
    assert.ok(conf.ok, "план и рендер совпали");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("2: сверка ловит вставку, которой нет в готовом файле", { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-miss-"));
  try {
    // Картинки со структурой: перцептивный хэш сравнивает рисунок кадра,
    // а не среднюю яркость, и на однотонных заливках он неразличим.
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc=s=1080x1920:d=4:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(dir, "out.mp4"),
    ]);
    await runFfmpeg(["-f", "lavfi", "-i", "smptebars=s=1080x1920", "-frames:v", "1", path.join(dir, "still.png")]);

    // план обещает красную вставку, а в файле её нет — это должно быть ошибкой
    const plan: EditPlan = {
      version: 1,
      duration: 4,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      events: [{ type: "B_ROLL", start: 1, end: 3, file: path.join(dir, "still.png") }],
    };
    const conf = await checkRenderConformance(dir, path.join(dir, "out.mp4"), plan);
    assert.equal(conf.ok, false, "расхождение плана и результата — ошибка");
    assert.equal(conf.issues.length, 3, "все три точки вставки помечены");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
