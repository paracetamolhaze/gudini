import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { closeBrowser, missingGlyphs, renderSlide } from "../lib/carousel/render";
import { CAROUSEL_STYLES } from "../lib/carousel/styles";
import { instagramImageProblems, jpegInfo } from "../lib/carousel/jpeg";
import type { Carousel, CarouselFormat, CarouselStyleId, Slide } from "../lib/carousel/types";

/**
 * Настоящий рендер карточек в безголовом Chromium (локально — Edge/Chrome, в контейнере —
 * браузер Playwright). Сеть не нужна. CAROUSEL_RENDER_OUT=<папка> сохраняет картинки для
 * визуальной проверки.
 */

const OUT = process.env.CAROUSEL_RENDER_OUT;
after(() => closeBrowser());

function carousel(style: CarouselStyleId, format: CarouselFormat = "portrait"): Carousel {
  return {
    id: "ctesttesttest01",
    schema: 1,
    createdAt: "",
    updatedAt: "",
    revision: 1,
    title: "Тест",
    request: { idea: "", wishes: "", slideCount: 4, language: "ru", style, format },
    style,
    format,
    language: "ru",
    footer: "@gudini_demo",
    story: [],
    slides: [],
    caption: "",
    hashtags: [],
    claimsToCheck: [],
    mode: "text_cards",
    job: null,
    publish: { status: "idle", items: [], publishAttempts: 0, log: [] },
    cost: { usd: 0, calls: 0 },
  };
}

const SLIDES: Slide[] = [
  { id: "stestcover00001", kind: "cover", kicker: "Сон без таблеток", title: "Как **высыпаться** за семь часов", body: "Пять привычек, которые работают уже с этой недели", bullets: [], cta: "" },
  {
    id: "stestcontent0001",
    kind: "content",
    kicker: "Шаг 1",
    title: "Ложитесь и вставайте в одно время",
    body: "Стабильный режим важнее длины сна: организм привыкает засыпать быстрее, а утро перестаёт быть мучением.",
    bullets: [],
    cta: "",
  },
  { id: "stestcontent0002", kind: "content", kicker: "Шаг 3", title: "Кофе — только до обеда", body: "Кофеин действует долго, поэтому:", bullets: ["Последняя чашка — до 14:00", "Крепкий чай тоже бодрит", "Вечером — вода или травяной чай"], cta: "" },
  { id: "stestfinal00001", kind: "final", kicker: "Итог", title: "Начните с одной привычки", body: "Выберите пункт, который проще всего, и держите его неделю — потом добавьте следующий.", bullets: [], cta: "Сохрани, чтобы не потерять" },
];

function save(name: string, buffer: Buffer) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), buffer);
}

for (const style of CAROUSEL_STYLES) {
  test(`стиль «${style.label}»: обложка, слайды и финал — JPEG 1080×1350, годный для Instagram`, async () => {
    const c = carousel(style.id);
    for (let i = 0; i < SLIDES.length; i++) {
      const out = await renderSlide(c, SLIDES[i], i, SLIDES.length);
      assert.ok(out.ok, out.ok ? "" : `слайд ${i + 1}: ${out.error}`);
      if (!out.ok) return;
      assert.deepEqual(jpegInfo(out.buffer), { width: 1080, height: 1350 });
      assert.deepEqual(instagramImageProblems(out.buffer), []);
      assert.equal(out.scale, 1, `слайд ${i + 1} поместился без уменьшения кегля`);
      save(`${style.id}-${i + 1}.jpg`, out.buffer);
    }
  });
}

test("квадратный формат 1080×1080", async () => {
  const c = carousel("contrast", "square");
  for (let i = 0; i < SLIDES.length; i++) {
    const out = await renderSlide(c, SLIDES[i], i, SLIDES.length);
    assert.ok(out.ok, out.ok ? "" : out.error);
    if (out.ok) {
      assert.deepEqual(jpegInfo(out.buffer), { width: 1080, height: 1080 });
      save(`square-${i + 1}.jpg`, out.buffer);
    }
  }
});

test("текст не помещается — ошибка слайда, а не обрезанная картинка", async () => {
  const out = await renderSlide(carousel("graphite"), { ...SLIDES[1], body: "Очень длинный текст, который не влезет. ".repeat(30) }, 1, 4);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /не помещается по высоте/);
});

test("умеренно длинный текст помещается уменьшением кегля", async () => {
  const body = "Стабильный режим важнее длины сна: организм привыкает засыпать быстрее, а утро перестаёт быть мучением. ".repeat(7);
  const out = await renderSlide(carousel("paper"), { ...SLIDES[1], body }, 1, 4);
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (out.ok) {
    assert.ok(out.scale < 1);
    save("paper-shrunk.jpg", out.buffer);
  }
});

test("слово длиннее строки — ошибка", async () => {
  const out = await renderSlide(carousel("graphite"), { ...SLIDES[1], title: "Электроэнцефалографическийисследовательскийкомплекс" }, 1, 4);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /слово длиннее строки/);
});

test("символ, которого нет в шрифте, — ошибка до рендера", async () => {
  assert.deepEqual(missingGlyphs(carousel("graphite"), { ...SLIDES[1], body: "Знак ↀ" }), ["ↀ"]);
  const out = await renderSlide(carousel("graphite"), { ...SLIDES[1], body: "Знак ↀ" }, 1, 4);
  assert.equal(out.ok, false);
});

test("карточка с иллюстрацией: картинка на весь кадр без растяжения, текст поверх, логотип; без картинки — ошибка", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-render-"));
  process.env.CAROUSEL_DATA_DIR = dir;
  const { createCarousel, updateCarousel, imageFilePath, newId } = await import("../lib/carousel/store");
  const { saveBrandAsset } = await import("../lib/carousel/design");
  const { DEFAULT_DESIGN } = await import("../lib/carousel/designShared");
  const { makePng } = await import("./carouselPng");
  // логотип аккаунта и «иллюстрация» 4:5 другого размера — object-fit: cover, без растяжения
  const design = saveBrandAsset("logo", makePng(240, 80, 3));
  const c0 = createCarousel({ idea: "Тест", wishes: "", slideCount: 3, language: "ru", style: "graphite", format: "portrait" }, { mode: "illustrated", design: { ...DEFAULT_DESIGN, ...design, author: "@gudini_demo" }, imageModel: "google/gemini-3.1-flash-image", imageResolution: "2K" });
  const versionId = newId("v");
  const slideId = newId("s");
  const file = `img-${slideId}-${versionId}.png`;
  fs.mkdirSync(path.dirname(imageFilePath(c0.id, file)), { recursive: true });
  fs.writeFileSync(imageFilePath(c0.id, file), makePng(640, 800, 2));
  const c = updateCarousel(c0.id, (x) => {
    x.slides = [
      { ...SLIDES[0], id: slideId, image: { brief: "scene", composition: "", textPlacement: "bottom", versions: [{ id: versionId, file, mediaType: "image/png", width: 640, height: 800, bytes: 1, model: "google/gemini-3.1-flash-image", resolution: "2K", kind: "generate", prompt: "p", references: [], cost: 0.1, estimated: false, at: "" }], currentId: versionId, rev: 0, status: "ready", attempts: 1 } },
      { ...SLIDES[2], id: newId("s"), image: { brief: "scene", composition: "", textPlacement: "top", versions: [{ id: versionId, file, mediaType: "image/png", width: 640, height: 800, bytes: 1, model: "google/gemini-3.1-flash-image", resolution: "2K", kind: "generate", prompt: "p", references: [], cost: 0.1, estimated: false, at: "" }], currentId: versionId, rev: 0, status: "ready", attempts: 1 } },
      { ...SLIDES[3], id: newId("s"), image: { brief: "scene", composition: "", textPlacement: "bottom", versions: [], rev: 0, status: "none", attempts: 0 } },
    ];
  });
  for (const i of [0, 1]) {
    const out = await renderSlide(c, c.slides[i], i, 3);
    assert.ok(out.ok, out.ok ? "" : `слайд ${i + 1}: ${out.error}`);
    if (out.ok) {
      assert.deepEqual(jpegInfo(out.buffer), { width: 1080, height: 1350 });
      assert.deepEqual(instagramImageProblems(out.buffer), []);
      save(`illustrated-${i + 1}.jpg`, out.buffer);
    }
  }
  const none = await renderSlide(c, c.slides[2], 2, 3);
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.error, /нет иллюстрации/);
});

test("разметка в тексте не исполняется: выводится как текст", async () => {
  const out = await renderSlide(carousel("ocean"), { ...SLIDES[1], title: '<img src=x onerror="document.title=1"> <b>жирный</b>', body: "</style><script>alert(1)</script>" }, 1, 4);
  assert.ok(out.ok, out.ok ? "" : out.error);
  if (out.ok) save("ocean-markup.jpg", out.buffer);
});
