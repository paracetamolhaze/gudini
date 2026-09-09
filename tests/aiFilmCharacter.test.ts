import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadCharacterProfile, characterBlock, referenceHash, MAX_REFERENCE_IMAGES } from "../lib/aiFilm/character";
import { runPool } from "../lib/aiFilm/generate";
import { loadUniverseProfile } from "../lib/aiFilm/universe";

const profile = {
  id: "gudini", name: "Gudini", role: "main_protagonist",
  description: "Gudini, a young shinobi", appearance: "platinum spiky hair", clothes: "olive vest",
  signature: "forehead plate", styleLock: "stylized anime", world: "hidden village", negative: "no logos",
};

function tmpCharacters(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-chars-"));
  const dir = path.join(base, "gudini");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(profile));
  return base;
}

test("профиль персонажа: identity из файла, эталоны находятся сами, хэш меняется с картинками", () => {
  const base = tmpCharacters();
  const dir = path.join(base, "gudini");
  const none = loadCharacterProfile("gudini", base);
  assert.equal(none.referenceFiles.length, 0);
  assert.equal(none.refHash, "no-refs");
  fs.writeFileSync(path.join(dir, "ref-2-face.png"), Buffer.from("png-face"));
  fs.writeFileSync(path.join(dir, "ref-1-full.png"), Buffer.from("png-full"));
  const two = loadCharacterProfile("gudini", base);
  assert.deepEqual(two.referenceImages, ["ref-1-full.png", "ref-2-face.png"]);
  assert.equal(two.referenceFiles.length, 2);
  assert.notEqual(two.refHash, none.refHash);
  fs.writeFileSync(path.join(dir, "ref-1-full.png"), Buffer.from("png-full-v2"));
  assert.notEqual(loadCharacterProfile("gudini", base).refHash, two.refHash, "другая картинка — другой хэш");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `z-${i}.jpg`), Buffer.from(`jpg${i}`));
  assert.equal(loadCharacterProfile("gudini", base).referenceFiles.length, MAX_REFERENCE_IMAGES);
  assert.match(characterBlock(two), /Main character GUDINI/);
  assert.match(characterBlock(two), /platinum spiky hair/);
  assert.equal(referenceHash([]), "no-refs");
});

test("без профиля персонажа — понятная ошибка с путём, а не пустой герой", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-empty-"));
  assert.throws(() => loadCharacterProfile("gudini", base), /нет профиля персонажа «gudini»/);
  const dir = path.join(base, "broken");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({ id: "broken", name: "X" }));
  assert.throws(() => loadCharacterProfile("broken", base), /нет поля «description»/);
});

test("профиль Gudini в репозитории валиден и без названий франшиз", () => {
  const c = loadCharacterProfile("gudini", path.join(process.cwd(), "assets", "ai-film", "characters"));
  assert.equal(c.name, "Gudini");
  assert.match(c.appearance, /platinum/);
  const text = `${c.description} ${c.appearance} ${c.clothes} ${c.signature} ${c.styleLock} ${c.world}`.toLowerCase();
  for (const banned of ["naruto", "konoha", "marvel", "avengers", "disney"]) assert.ok(!text.includes(banned), `в профиле есть «${banned}»`);
});

test("пул: не больше n задач одновременно, после ошибки новые не стартуют, запущенные доходят до конца", async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const tasks = [0, 1, 2, 3, 4, 5].map((i) => async () => {
    started.push(i);
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    if (i === 1) throw new Error(`boom ${i}`);
    return i;
  });
  await assert.rejects(runPool(tasks, 2), /boom 1/);
  assert.ok(peak <= 2, `одновременно было ${peak}`);
  assert.ok(started.length < 6, "после ошибки часть задач не стартовала");
  assert.deepEqual(await runPool([async () => 1, async () => 2, async () => 3], 2), [1, 2, 3]);
});

test("профиль мира в репозитории валиден: правила адаптации, anti-drift, хэш; без профиля — ошибка", () => {
  const u = loadUniverseProfile("gudini-anime-cel", path.join(process.cwd(), "assets", "ai-film", "universes"));
  assert.equal(u.id, "gudini-anime-cel");
  assert.ok(u.contentRules.length >= 5);
  assert.ok(u.contentRules.some((r) => /CONTENT IS LITERAL/.test(r)));
  assert.match(u.forbiddenDrift, /events with metaphors/);
  assert.match(u.hash, /^[0-9a-f]{12}$/);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-univ-"));
  assert.throws(() => loadUniverseProfile("nope", base), /нет профиля мира «nope»/);
});
