import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { scoreHeadline, selectHeadline, applyHeadlinePreflight, matchAnchors, resolveHeadline } from "../lib/coverHeadline";
import { buildCover } from "../lib/coverPipeline";
import type { CoverConcept } from "../lib/cover";
import type { CoverQcResult } from "../lib/coverQc";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gudini-headline-"));
}

function concept(candidates: string[], anchors: string[] = []): CoverConcept {
  return {
    headline: candidates[0],
    headlineLines: [{ text: candidates[0], accent: false }],
    headlineCandidates: candidates,
    headlineAnchor: anchors,
    typographyDirection: "ACCENT_BOX",
    emotion: "frozen alarm",
    scene: { mainSubject: "person turning head", storyObject: "tiger in courtyard", environment: "courtyard" },
    composition: { facePosition: "left", faceScale: "very_large", headlineArea: "lower", allowHands: false },
    design_notes: [],
  };
}

test("Preflight 1: из трёх вариантов про тигра выбирается «ТИГР У ДОМА»", () => {
  const r = selectHeadline(["ТИГР ВО ДВОРЕ НЕ БЕГИ", "ТИГР У ДОМА", "ОПАСНЫЙ ТИГР ОКАЗАЛСЯ У ДОМА"]);
  assert.equal(r.selectedHeadline, "ТИГР У ДОМА");
  assert.ok(r.scores.every((s) => s.score <= 100));
});

test("Preflight 2: словесная формулировка выигрывает у цифровой при том же смысле", () => {
  const r = selectHeadline(["5000$ СТАЛИ 300$", "ДЕНЬГИ СГОРЕЛИ", "ПОТЕРЯЛ $5000"]);
  assert.equal(r.selectedHeadline, "ДЕНЬГИ СГОРЕЛИ");
  const digits = scoreHeadline("5000$ СТАЛИ 300$");
  const words = scoreHeadline("ДЕНЬГИ СГОРЕЛИ");
  const oneNumber = scoreHeadline("ПОТЕРЯЛ $5000");
  assert.ok(words.score > oneNumber.score, "слова лучше одного числа");
  assert.ok(oneNumber.score > digits.score, "одно число безопаснее цепочки чисел с валютой");
});

test("Preflight 3: короткий вариант выигрывает, а при ничьей — более информативный", () => {
  assert.ok(scoreHeadline("ДЕТИ НА ЗАКАЗ").score > scoreHeadline("ДЕТЕЙ РЕДАКТИРУЮТ ДО РОЖДЕНИЯ").score);
  assert.ok(scoreHeadline("ПИЛОТ ВЫПРЫГНУЛ").score > scoreHeadline("ПИЛОТ ВЫПРЫГНУЛ ИЗ САМОЛЁТА НА ХОДУ").score);
  assert.equal(scoreHeadline("ТИГР У ДОМА").penalties.length, 0, "идеальный заголовок без штрафов");
  // случай из E2E: все три по 100 баллов, но «НЕ БЕГИ» теряет сам сюжет обложки
  assert.equal(selectHeadline(["ТИГР ВО ДВОРЕ", "ЗВЕРЬ НА СВОБОДЕ", "НЕ БЕГИ"]).selectedHeadline, "ТИГР ВО ДВОРЕ");
  assert.equal(scoreHeadline("ГЕНЫ ПОД ЗАКАЗ").contentWords, 2, "«ПОД» — служебное слово");
});

test("Anchor: заголовок обязан сохранить предмет ролика", () => {
  // тигр: формально идеальное «НЕ БЕГИ» теряет сам предмет
  const tiger = selectHeadline(["НЕ БЕГИ", "ТИГР ВО ДВОРЕ", "ТИГР У ДОМА"], ["тигр"]);
  assert.equal(tiger.selectedHeadline, "ТИГР У ДОМА");
  assert.equal(tiger.scores.find((s) => s.headline === "НЕ БЕГИ")!.anchorHit, false);

  // деньги: «ВСЁ ПРОПАЛО» непонятно о чём
  const money = selectHeadline(["ВСЁ ПРОПАЛО", "ДЕНЬГИ СГОРЕЛИ"], ["деньги", "потеря"]);
  assert.equal(money.selectedHeadline, "ДЕНЬГИ СГОРЕЛИ");

  // генетика: «БУДУЩЕЕ НАСТАЛО» слишком абстрактно
  const genes = selectHeadline(["БУДУЩЕЕ НАСТАЛО", "ДЕТИ НА ЗАКАЗ"], ["дети", "гены"]);
  assert.equal(genes.selectedHeadline, "ДЕТИ НА ЗАКАЗ");

  // якорь ловится и в косвенной форме
  assert.deepEqual(matchAnchors("ДЕТЕЙ РЕДАКТИРУЮТ", ["дети"]), ["дети"]);
  assert.deepEqual(matchAnchors("ТИГРА ВЫПУСТИЛИ", ["тигр"]), ["тигр"]);
  assert.deepEqual(matchAnchors("ВСЁ ПРОПАЛО", ["деньги"]), []);
});

test("Anchor: якорь сильнее формы; потеря якоря всеми = шлюз закрыт (ok=false)", () => {
  // кандидат с якорем побеждает, даже будучи длиннее и «хуже» по форме
  const r = selectHeadline(["НЕ БЕГИ", "ОПАСНЫЙ ТИГР ОКАЗАЛСЯ У ДОМА"], ["тигр"]);
  assert.equal(r.ok, true);
  assert.equal(r.selectedHeadline, "ОПАСНЫЙ ТИГР ОКАЗАЛСЯ У ДОМА");

  // если якорь потеряли все — картинку заказывать нельзя
  const none = selectHeadline(["ВСЁ ПРОПАЛО", "БУДУЩЕЕ НАСТАЛО"], ["деньги"]);
  assert.equal(none.ok, false, "шлюз обязан закрыться до платной генерации");
  assert.ok(none.reason.includes("картинка не заказывается"));
});

test("Шлюз: вторая ТЕКСТОВАЯ попытка спасает, картинка заказывается один раз", async () => {
  const dir = tmpDir();
  const notes: (string | null)[] = [];
  const resolved = await resolveHeadline(
    async (attempt, strictNote) => {
      notes.push(strictNote);
      return attempt === 1
        ? concept(["ВСЁ ПРОПАЛО", "БУДУЩЕЕ НАСТАЛО", "КОНЕЦ БЛИЗОК"], ["деньги"])
        : concept(["ДЕНЬГИ СГОРЕЛИ", "ПОТЕРЯЛ ВСЁ", "ДЕНЬГИ ИСПАРИЛИСЬ"], ["деньги"]);
    },
    dir,
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attempts, 2);
  assert.equal(resolved.selection!.selectedHeadline, "ДЕНЬГИ СГОРЕЛИ");
  assert.equal(notes[0], null, "первая попытка идёт без корректирующей инструкции");
  assert.ok(notes[1]?.includes("headlineAnchor"), "вторая попытка требует якорь жёстко");
  assert.ok(fs.existsSync(path.join(dir, "cover-headline-preflight.json")));
  assert.ok(fs.existsSync(path.join(dir, "cover-headline-preflight-2.json")), "обе попытки залогированы");
});

test("Шлюз: обе текстовые попытки провалились → HEADLINE_FAILED, генератор не вызывается", async () => {
  const dir = tmpDir();
  let textAttempts = 0;
  const resolved = await resolveHeadline(
    async () => {
      textAttempts++;
      return concept(["ВСЁ ПРОПАЛО", "БУДУЩЕЕ НАСТАЛО", "КОНЕЦ БЛИЗОК"], ["деньги", "потеря"]);
    },
    dir,
  );
  assert.equal(resolved.ok, false);
  assert.equal(textAttempts, 2, "ровно 2 текстовые попытки — они почти бесплатны");
  assert.equal(fs.existsSync(path.join(dir, "cover-attempt-1.png")), false, "картинка не заказывалась");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
});

test("Шлюз: заголовок пользователя проходит без проверки якоря", async () => {
  const dir = tmpDir();
  const resolved = await resolveHeadline(
    async () => {
      const c = concept(["ВСЁ ПРОПАЛО"], ["деньги"]);
      return c;
    },
    dir,
    { ignoreAnchor: true },
  );
  assert.equal(resolved.ok, true, "явный выбор пользователя не блокируется");
  assert.equal(resolved.attempts, 1);
});

test("Preflight 4: после отбора image-генератор вызывается ровно один раз", async () => {
  const dir = tmpDir();
  const c = concept(["ТИГР ВО ДВОРЕ НЕ БЕГИ", "ТИГР У ДОМА", "ХИЩНИК У ДОМА"]);
  const selection = applyHeadlinePreflight(c, dir);
  assert.equal(selection.selectedHeadline, "ТИГР У ДОМА");
  assert.equal(c.headlineLines.map((l) => l.text).join(" "), "ТИГР У ДОМА", "headline зафиксирован в концепте");

  let generated = 0;
  const prompts: string[] = [];
  const PASS: CoverQcResult = { status: "PASS", pass: true, reasons: [], confidence: 0.95, cost: 0.002 };
  await buildCover(dir, c, {
    generateImage: async (prompt, out) => {
      generated++;
      prompts.push(prompt);
      fs.writeFileSync(out, "png");
      return { cost: 0.068 };
    },
    runQc: async () => PASS,
    finish: async (_d, src, out) => (fs.copyFileSync(src, out), out),
    encodeFinal: async (_d, _b, out) => (fs.writeFileSync(out, "jpg"), out),
  });
  assert.equal(generated, 1);
  assert.ok(prompts[0].includes("ТИГР"), "в промпт ушёл выбранный заголовок");
  assert.equal(prompts[0].includes("ВО ДВОРЕ"), false, "проигравшие варианты в промпт не попадают");
  const log = JSON.parse(fs.readFileSync(path.join(dir, "cover-headline-preflight.json"), "utf8"));
  assert.equal(log.headlineCandidates.length, 3);
  assert.equal(log.scores.length, 3);
  assert.equal(log.selectedHeadline, "ТИГР У ДОМА");
});

test("Preflight 5: провал QC после отбора не запускает новую генерацию", async () => {
  const dir = tmpDir();
  const c = concept(["ТИГР У ДОМА", "ХИЩНИК РЯДОМ", "ТИГР ВО ДВОРЕ НЕ БЕГИ"]);
  applyHeadlinePreflight(c, dir);
  let generated = 0;
  const FAIL: CoverQcResult = { status: "EXTRA_TEXT", pass: false, reasons: ["мусор"], confidence: 0.9, cost: 0.002 };
  const PASS: CoverQcResult = { status: "PASS", pass: true, reasons: [], confidence: 0.95, cost: 0.002 };
  const results = [FAIL, PASS]; // если бы был авто-повтор, вторая проверка «спасла» бы обложку
  let qcCall = 0;
  const r = await buildCover(dir, c, {
    generateImage: async (_p, out) => {
      generated++;
      fs.writeFileSync(out, "png");
      return { cost: 0.068 };
    },
    runQc: async () => results[qcCall++],
  });
  assert.equal(generated, 1, "QC не имеет права инициировать генерацию");
  assert.equal(r.status, "COVER_FAILED");
  assert.equal(fs.existsSync(path.join(dir, "cover.jpg")), false);
});
