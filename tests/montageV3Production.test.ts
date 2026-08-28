import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

/**
 * V3 должен быть тем монтажом, который реально работает в production,
 * а старый — недостижимым. Иначе однажды выйдет ролик, собранный не той
 * системой, и понять это по результату будет нельзя.
 */

const pipeline = fs.readFileSync("lib/pipeline.ts", "utf8");
const v3 = fs.readFileSync("lib/montageV3Pipeline.ts", "utf8");

test("1: production вызывает V3 и не импортирует старый монтаж", () => {
  assert.ok(pipeline.includes("runMontageV3("), "pipeline запускает V3");
  for (const legacy of ["editPlanner", "editPlannerPack", './broll"']) {
    assert.ok(!pipeline.includes(`from "./${legacy}`), `pipeline не импортирует ${legacy}`);
  }
  assert.ok(!pipeline.includes("planEdit("), "старый планировщик не вызывается");
  assert.ok(!pipeline.includes("prepareBroll("), "слепой подбор перебивок не вызывается");
});

test("2: отката на старый монтаж при сбое V3 нет", () => {
  // сбой любой стадии обязан останавливать задачу
  assert.ok(v3.includes("throw new Error"), "V3 бросает ошибку при сбое стадии");
  assert.ok(!/catch[\s\S]{0,200}(planEdit|prepareBroll|editPlanner)/.test(pipeline), "нет отката на старый путь");
  // выключенный V3 — это остановка, а не переход к старой системе
  assert.ok(pipeline.includes("MONTAGE_V3=false"), "выключение V3 объяснено явной ошибкой");
  assert.ok(pipeline.includes("а старого пути больше нет"), "старый путь удалён, а не спрятан");
});

test("3: порядок производственного пути соблюдён", () => {
  const order = ["buildScriptBeats(", "buildAssetPack(", "directMontage(", "validateMontage("];
  let prev = -1;
  for (const step of order) {
    const at = v3.indexOf(step);
    assert.ok(at > prev, `${step} идёт после предыдущей стадии`);
    prev = at;
  }
  // план для рендера собирается только из проверенных материалов пакета
  assert.ok(v3.includes("byId.get(e.assetId)"), "события берут материал из пакета по id");
  assert.ok(v3.includes("fs.existsSync(file)"), "в план не попадает материал без файла");
});
