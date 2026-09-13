import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { makePng } from "./carouselPng";
import { OpenRouterError, type ImageRequest } from "../lib/carousel/openrouter";
import { generateSlideImage, generateSlideImages, markOrphanInFlight, setImageDeps, slidesNeedingImages } from "../lib/carousel/images";
import { createCarousel, getCarousel, imageFilePath, newId, updateCarousel, CarouselError } from "../lib/carousel/store";
import { readSpend } from "../lib/carousel/spend";
import type { Carousel, Slide } from "../lib/carousel/types";
import { DEFAULT_DESIGN } from "../lib/carousel/designShared";

/**
 * Оркестрация иллюстраций на поддельном генераторе: опора серии и референсы, версии,
 * изоляция ошибок, неизвестный исход без повтора, защита правок от позднего ответа.
 * Ни один запрос наружу не уходит.
 */

const requests: ImageRequest[] = [];
let respond: (req: ImageRequest, n: number) => Promise<{ buffer: Buffer; mediaType: "image/png"; cost: number | null }>;
const okImage = async (_req: ImageRequest, n: number) => ({ buffer: makePng(8, 10, n), mediaType: "image/png" as const, cost: 0.09 });
const timeout = () => new OpenRouterError("нет ответа", "timeout", { uncertain: true });

before(() => {
  process.env.CAROUSEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-images-"));
  process.env.CAROUSEL_OPENROUTER_API_KEY = "sk-or-test-0000000000";
  process.env.CAROUSEL_MONTHLY_BUDGET_USD = "50";
  process.env.CAROUSEL_MAX_COST_PER_CAROUSEL_USD = "5";
  process.env.CAROUSEL_IMAGE_CONCURRENCY = "2";
  setImageDeps({
    generate: async (req) => {
      requests.push(req);
      return respond(req, requests.length);
    },
  });
});
after(() => setImageDeps(null));

function slide(kind: Slide["kind"], n: number): Slide {
  return {
    id: newId("s"),
    kind,
    kicker: "",
    title: `Слайд ${n}`,
    body: "Текст",
    bullets: [],
    cta: "",
    image: { brief: `Scene ${n}: a person doing thing number ${n} in a cozy room`, composition: "medium shot", textPlacement: "bottom", versions: [], rev: 0, status: "none", attempts: 0 },
  };
}

function illustrated(count = 4): Carousel {
  const c = createCarousel({ idea: "Тест", wishes: "", slideCount: count, language: "ru", style: "graphite", format: "portrait" }, { mode: "illustrated", design: DEFAULT_DESIGN, imageModel: "google/gemini-3.1-flash-image", imageResolution: "2K" });
  return updateCarousel(c.id, (x) => {
    x.visual = { idea: "cozy life", style: "soft 3D clay render", palette: "warm beige", lighting: "morning light", characters: [{ name: "Mia", look: "young woman, short dark hair, green sweater" }], objects: ["ceramic mug"] };
    x.slides = Array.from({ length: count }, (_, i) => slide(i === 0 ? "cover" : i === count - 1 ? "final" : "content", i + 1));
  });
}

const step = () => {};

test("серия: первая картинка рисуется одна и становится опорой, остальные получают её референсом", async () => {
  requests.length = 0;
  respond = okImage;
  const c = illustrated(4);
  const outcomes = await generateSlideImages(c.id, "job1", c.slides.map((s) => s.id), step, [0, 100]);
  assert.deepEqual(
    outcomes.map((o) => o.ok),
    [true, true, true, true],
  );
  assert.equal(requests.length, 4);
  assert.equal(requests[0].references.length, 0, "первый запрос без опоры");
  assert.match(requests[0].prompt, /slide 1 of 4/);
  assert.match(requests[0].prompt, /Mia: young woman, short dark hair/);
  assert.match(requests[0].prompt, /Do not draw any text/);
  assert.match(requests[0].prompt, /lower 40% of the frame visually calm/);
  assert.equal(requests[0].aspectRatio, "4:5");
  assert.equal(requests[0].resolution, "2K");
  for (const r of requests.slice(1)) {
    assert.equal(r.references.length, 1, "остальные — с опорой серии");
    assert.match(r.references[0], /^data:image\/png;base64,/);
    assert.match(r.prompt, /Reference image 1 is an already approved slide/);
  }
  const after = getCarousel(c.id)!;
  assert.equal(after.anchor?.slideId, after.slides[0].id);
  for (const s of after.slides) {
    assert.equal(s.image!.status, "ready");
    assert.equal(s.image!.versions.length, 1);
    assert.equal(s.image!.currentId, s.image!.versions[0].id);
    assert.ok(fs.existsSync(imageFilePath(c.id, s.image!.versions[0].file)));
    assert.equal(s.image!.versions[0].cost, 0.09);
    assert.equal(s.image!.versions[0].estimated, false);
    assert.equal(s.image!.versions[0].width, 8);
  }
  assert.equal(after.revision, c.revision + 4, "каждая новая текущая картинка — новая ревизия");
  const spend = readSpend().filter((e) => e.carouselId === c.id);
  assert.equal(spend.length, 4);
  assert.ok(spend.every((e) => e.status === "done" && e.cost === 0.09 && e.kind === "image"));
});

test("ошибка одного слайда не трогает остальные; повтор рисует только недостающий и не платит за готовые", async () => {
  requests.length = 0;
  let calls = 0;
  respond = async (req, n) => {
    calls++;
    if (/slide 2 of 4/.test(req.prompt) && calls <= 2) throw new OpenRouterError("Модель отказалась", "moderation");
    return okImage(req, n);
  };
  const c = illustrated(4);
  const outcomes = await generateSlideImages(c.id, "job2", c.slides.map((s) => s.id), step, [0, 100]);
  const failed = outcomes.filter((o) => !o.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].index, 1);
  assert.match(failed[0].error!, /отказалась/);
  const mid = getCarousel(c.id)!;
  assert.equal(mid.slides[1].image!.status, "error");
  assert.equal(mid.slides[1].image!.versions.length, 0);
  assert.equal(mid.slides.filter((s) => s.image!.status === "ready").length, 3);
  assert.deepEqual(slidesNeedingImages(mid), [mid.slides[1].id]);

  const before = requests.length;
  const again = await generateSlideImages(c.id, "job3", slidesNeedingImages(mid), step, [0, 100]);
  assert.equal(again.length, 1);
  assert.equal(again[0].ok, true);
  assert.equal(requests.length - before, 1, "повтор — один запрос, за готовые слайды не платится");
  assert.equal(getCarousel(c.id)!.slides[1].image!.status, "ready");
  assert.equal(readSpend().filter((e) => e.carouselId === c.id && e.status === "failed").length, 1);
});

test("временная ошибка провайдера повторяется один раз; неизвестный исход — не повторяется и помечается", async () => {
  requests.length = 0;
  let n = 0;
  respond = async (req, k) => {
    n++;
    if (n === 1) throw new OpenRouterError("временно", "rate_limit", { retryable: true });
    return okImage(req, k);
  };
  const c = illustrated(3);
  const one = await generateSlideImage(c.id, "job4", c.slides[0].id, { mode: "generate" });
  assert.equal(one.ok, true);
  assert.equal(requests.length, 2, "один повтор после 429");

  requests.length = 0;
  respond = async () => {
    throw timeout();
  };
  const two = await generateSlideImage(c.id, "job4", c.slides[1].id, { mode: "generate" });
  assert.equal(two.ok, false);
  assert.equal(two.uncertain, true);
  assert.equal(requests.length, 1, "после тайм-аута повторной отправки нет");
  const s1 = getCarousel(c.id)!.slides[1].image!;
  assert.equal(s1.status, "uncertain");
  assert.equal(s1.inFlight, undefined);
  assert.match(s1.error!, /мог выполниться и быть оплачен/);
  const entry = readSpend().find((e) => e.carouselId === c.id && e.slideId === c.slides[1].id)!;
  assert.equal(entry.status, "uncertain");
  assert.equal(entry.estimated, true);
  assert.ok(entry.cost > 0);

  // обычный повтор недостающих такой слайд пропускает; только явный includeUncertain рисует заново
  respond = okImage;
  requests.length = 0;
  const skipped = await generateSlideImages(c.id, "job5", [c.slides[1].id], step, [0, 100]);
  assert.equal(skipped[0].skipped, true);
  assert.equal(requests.length, 0);
  const forced = await generateSlideImages(c.id, "job6", [c.slides[1].id], step, [0, 100], { includeUncertain: true });
  assert.equal(forced[0].ok, true);
  assert.equal(requests.length, 1);
});

test("поздний ответ не перезаписывает правку пользователя: версия сохраняется, но не становится текущей", async () => {
  requests.length = 0;
  const c = illustrated(3);
  respond = async (req, n) => {
    // пока генератор «думает», пользователь меняет место текста на слайде
    updateCarousel(c.id, (x) => {
      x.slides[0].image!.textPlacement = "top";
      x.slides[0].image!.rev += 1;
    });
    return okImage(req, n);
  };
  const out = await generateSlideImage(c.id, "job7", c.slides[0].id, { mode: "generate" });
  assert.equal(out.ok, true);
  assert.equal(out.notCurrent, true);
  const img = getCarousel(c.id)!.slides[0].image!;
  assert.equal(img.versions.length, 1);
  assert.equal(img.currentId, undefined);
  assert.equal(img.textPlacement, "top");

  // второй запуск без правок — картинка становится текущей
  respond = okImage;
  const out2 = await generateSlideImage(c.id, "job8", c.slides[0].id, { mode: "generate" });
  assert.equal(out2.notCurrent, false);
  const img2 = getCarousel(c.id)!.slides[0].image!;
  assert.equal(img2.versions.length, 2);
  assert.equal(img2.currentId, img2.versions[1].id);
});

test("правка картинки поручением: текущая версия — первый референс, опора серии — второй, остальные слайды не трогаются", async () => {
  requests.length = 0;
  respond = okImage;
  const c = illustrated(3);
  await generateSlideImages(c.id, "job9", c.slides.map((s) => s.id), step, [0, 100]);
  const before = getCarousel(c.id)!;
  requests.length = 0;
  const out = await generateSlideImage(c.id, "job10", c.slides[2].id, { mode: "edit", instruction: "сделай светлее" });
  assert.equal(out.ok, true);
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.references.length, 2);
  assert.match(req.prompt, /^Edit reference image 1/);
  assert.match(req.prompt, /сделай светлее/);
  assert.match(req.prompt, /Reference image 2 is another approved slide/);
  const current = before.slides[2].image!.versions[0];
  const expectedRef = `data:image/png;base64,${fs.readFileSync(imageFilePath(c.id, current.file)).toString("base64")}`;
  assert.equal(req.references[0], expectedRef, "первый референс — текущая картинка слайда");
  const after = getCarousel(c.id)!;
  assert.equal(after.slides[2].image!.versions.length, 2);
  assert.equal(after.slides[2].image!.versions[1].kind, "edit");
  assert.equal(after.slides[2].image!.versions[1].instruction, "сделай светлее");
  assert.equal(after.slides[2].image!.versions[1].references[0].kind, "source");
  for (const i of [0, 1]) assert.deepEqual(after.slides[i].image!.versions, before.slides[i].image!.versions, `слайд ${i + 1} не изменился`);
});

test("запрос, прерванный перезапуском: при возобновлении — неизвестный исход без новой оплаты", async () => {
  requests.length = 0;
  const c = illustrated(3);
  // имитация обработчика, умершего после отправки запроса
  updateCarousel(c.id, (x) => {
    x.slides[1].image!.status = "generating";
    x.slides[1].image!.inFlight = { at: new Date().toISOString(), jobId: "dead", spendId: "sp000000000000dead" };
  });
  respond = okImage;
  const out = await generateSlideImage(c.id, "job11", c.slides[1].id, { mode: "generate" });
  assert.equal(out.uncertain, true);
  assert.equal(requests.length, 0);
  assert.equal(getCarousel(c.id)!.slides[1].image!.status, "uncertain");

  updateCarousel(c.id, (x) => {
    x.slides[2].image!.status = "generating";
    x.slides[2].image!.inFlight = { at: new Date().toISOString(), jobId: "dead", spendId: "sp000000000000dead" };
  });
  assert.equal(markOrphanInFlight(), 1);
  assert.equal(getCarousel(c.id)!.slides[2].image!.status, "uncertain");
  assert.equal(getCarousel(c.id)!.slides[2].image!.inFlight, undefined);
});

test("бюджет исчерпан — генерация останавливается до запроса, готовые картинки остаются", async () => {
  requests.length = 0;
  respond = okImage;
  process.env.CAROUSEL_MAX_COST_PER_CAROUSEL_USD = "0.15";
  try {
    const c = illustrated(4);
    await assert.rejects(generateSlideImages(c.id, "job12", c.slides.map((s) => s.id), step, [0, 100]), (e: CarouselError) => e.status === 402 && /одну карусель/.test(e.message));
    const after = getCarousel(c.id)!;
    assert.equal(after.slides[0].image!.status, "ready", "первая картинка сохранена");
    assert.ok(requests.length < 4, "до предела дошли не все запросы");
    assert.ok(after.slides.some((s) => s.image!.status === "error" && /Предел расходов/.test(s.image!.error ?? "")));
  } finally {
    process.env.CAROUSEL_MAX_COST_PER_CAROUSEL_USD = "5";
  }
});

test("без ключа раздела генерация не запускается; без описания — ошибка слайда без запроса", async () => {
  requests.length = 0;
  const c = illustrated(3);
  const key = process.env.CAROUSEL_OPENROUTER_API_KEY;
  delete process.env.CAROUSEL_OPENROUTER_API_KEY;
  try {
    await assert.rejects(generateSlideImage(c.id, "job13", c.slides[0].id, { mode: "generate" }), (e: CarouselError) => e.code === "config");
  } finally {
    process.env.CAROUSEL_OPENROUTER_API_KEY = key;
  }
  updateCarousel(c.id, (x) => (x.slides[0].image!.brief = ""));
  const out = await generateSlideImage(c.id, "job13", c.slides[0].id, { mode: "generate" });
  assert.equal(out.ok, false);
  assert.match(out.error!, /нет описания/);
  assert.equal(requests.length, 0);
});
