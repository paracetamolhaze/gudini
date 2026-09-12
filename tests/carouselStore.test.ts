import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  acquireRunnerLock,
  attachJob,
  carouselDir,
  claimJob,
  cleanupSlideFiles,
  createCarousel,
  deleteCarousel,
  findRunnableJob,
  getCarousel,
  isCarouselId,
  JOB_STALE_MS,
  listCarousels,
  mediaQuery,
  newId,
  readRunnerLock,
  releaseRunnerLock,
  RUNNER_STALE_MS,
  slideFilePath,
  slidesDir,
  touchRunnerLock,
  updateCarousel,
  verifyMedia,
} from "../lib/carousel/store";
import { applyManualEdit } from "../lib/carousel/edit";
import { publishReadiness } from "../lib/carousel/view";
import { slideHash } from "../lib/carousel/templates";
import type { CarouselRequest, Slide } from "../lib/carousel/types";

const request: CarouselRequest = { idea: "Как высыпаться", wishes: "", slideCount: 4, language: "ru", style: "graphite", format: "portrait" };

/** Каждый тест — в своей временной папке: реальные данные сайта не трогаются. */
function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-"));
  process.env.CAROUSEL_DATA_DIR = dir;
  return dir;
}

function slides(): Slide[] {
  return [
    { id: newId("s"), kind: "cover", kicker: "", title: "Обложка", body: "", bullets: [], cta: "" },
    { id: newId("s"), kind: "content", kicker: "", title: "Первая мысль", body: "Текст", bullets: [], cta: "" },
    { id: newId("s"), kind: "content", kicker: "", title: "Вторая мысль", body: "Текст", bullets: [], cta: "" },
    { id: newId("s"), kind: "final", kicker: "", title: "Итог", body: "Текст", bullets: [], cta: "Сохрани" },
  ];
}

test("создание, чтение, список и ревизия", () => {
  const root = freshRoot();
  const c = createCarousel(request);
  assert.ok(isCarouselId(c.id));
  assert.ok(fs.existsSync(path.join(root, c.id, "carousel.json")));
  assert.equal(getCarousel(c.id)?.title, "Как высыпаться");
  assert.equal(listCarousels().length, 1);
  updateCarousel(c.id, (x) => (x.caption = "подпись"), { content: true });
  updateCarousel(c.id, (x) => (x.cost.calls = 1));
  const after = getCarousel(c.id)!;
  assert.equal(after.revision, 2);
  assert.equal(after.caption, "подпись");
});

test("id и имена файлов не выводят за папку каруселей", () => {
  freshRoot();
  for (const bad of ["../x", "c../../etc", "C1234567890123", "c1", "c1234567890123/..", ""]) assert.equal(isCarouselId(bad), false, bad);
  assert.throws(() => carouselDir("../../data"), /Недопустимый id/);
  const c = createCarousel(request);
  assert.throws(() => slideFilePath(c.id, "../../settings.json"), /Недопустимое имя/);
  assert.throws(() => slideFilePath(c.id, "slide-x.jpg"), /Недопустимое имя/);
  assert.equal(getCarousel("../../db"), null);
  assert.throws(() => updateCarousel("../../db", () => {}), /Недопустимый id/);
});

test("второе задание поверх идущего — отказ 409", () => {
  freshRoot();
  const c = createCarousel(request);
  updateCarousel(c.id, (x) => {
    attachJob(x, "generate");
  });
  assert.throws(
    () => updateCarousel(c.id, (x) => void attachJob(x, "render")),
    (e: any) => e.status === 409 && /Уже выполняется/.test(e.message),
  );
  // неудачная попытка ничего не записала
  assert.equal(getCarousel(c.id)?.job?.type, "generate");
});

test("задание: захват, защита от второго обработчика, возобновление после прерывания", () => {
  freshRoot();
  const c = createCarousel(request);
  const job = updateCarousel(c.id, (x) => void attachJob(x, "render")).job!;
  assert.deepEqual(findRunnableJob(), { carouselId: c.id, jobId: job.id });
  const first = claimJob(c.id, job.id, 111);
  assert.equal(first?.resumed, false);
  assert.equal(getCarousel(c.id)?.job?.state, "running");
  assert.equal(claimJob(c.id, job.id, 222), null, "живое задание не захватывается повторно");
  assert.equal(findRunnableJob(), null);
  const later = Date.now() + JOB_STALE_MS + 1000;
  assert.deepEqual(findRunnableJob(later), { carouselId: c.id, jobId: job.id });
  const resumed = claimJob(c.id, job.id, 222, later);
  assert.equal(resumed?.resumed, true);
  assert.equal(getCarousel(c.id)?.job?.attempts, 2);
});

test("удаление: отказ при идущем задании и неподтверждённой публикации; соседняя карусель цела", () => {
  freshRoot();
  const keep = createCarousel(request);
  const c = createCarousel(request);
  updateCarousel(c.id, (x) => void attachJob(x, "render"));
  assert.throws(() => deleteCarousel(c.id), (e: any) => e.status === 409);
  updateCarousel(c.id, (x) => {
    x.job!.state = "done";
    x.publish.status = "uncertain";
    x.publish.stage = "publish_sent";
  });
  assert.throws(() => deleteCarousel(c.id), (e: any) => e.status === 409 && /не подтверждён/.test(e.message));
  updateCarousel(c.id, (x) => {
    x.publish.status = "published";
    x.publish.stage = "done";
  });
  deleteCarousel(c.id);
  assert.equal(getCarousel(c.id), null);
  assert.ok(getCarousel(keep.id));
  assert.deepEqual(
    listCarousels().map((x) => x.id),
    [keep.id],
  );
  assert.throws(() => deleteCarousel(c.id), (e: any) => e.status === 404);
});

test("подписанная ссылка на слайд: подделка, чужой файл, чужая карусель и истёкший срок не проходят", () => {
  freshRoot();
  const c = createCarousel(request);
  const other = createCarousel(request);
  const file = `slide-s${"a".repeat(20)}-0123456789ab.jpg`;
  const now = 1_800_000_000;
  const q = new URLSearchParams(mediaQuery(c.id, file, now));
  const exp = q.get("exp");
  const sig = q.get("sig")!;
  assert.equal(verifyMedia(c.id, file, exp, sig, now + 100), true);
  assert.equal(verifyMedia(c.id, file, exp, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), now + 100), false);
  assert.equal(verifyMedia(c.id, `slide-s${"b".repeat(20)}-0123456789ab.jpg`, exp, sig, now + 100), false);
  assert.equal(verifyMedia(other.id, file, exp, sig, now + 100), false);
  assert.equal(verifyMedia(c.id, file, exp, sig, now + 7 * 3600), false);
  assert.equal(verifyMedia(c.id, file, null, sig, now), false);
  const far = new URLSearchParams(mediaQuery(c.id, file, now, 30 * 86400));
  assert.equal(verifyMedia(c.id, file, far.get("exp"), far.get("sig"), now), false);
});

test("ручная правка: устаревшая ревизия, пустой заголовок, порядок с обложкой первой", () => {
  freshRoot();
  const c = createCarousel(request);
  const s = slides();
  updateCarousel(c.id, (x) => (x.slides = s), { content: true });

  const stale = getCarousel(c.id)!;
  assert.throws(() => applyManualEdit(stale, { revision: stale.revision - 1, caption: "a" }), (e: any) => e.status === 409);

  const edit = getCarousel(c.id)!;
  const r = applyManualEdit(edit, { revision: edit.revision, slides: [{ id: s[1].id, title: "Новый заголовок" }], hashtags: "#сон сон #отдых" });
  assert.equal(r.contentChanged, true);
  assert.equal(r.renderNeeded, true);
  assert.equal(edit.slides[1].title, "Новый заголовок");
  assert.deepEqual(edit.hashtags, ["#сон", "#отдых"]);

  const same = getCarousel(c.id)!;
  assert.equal(applyManualEdit(same, { revision: same.revision }).contentChanged, false);

  const empty = getCarousel(c.id)!;
  assert.throws(() => applyManualEdit(empty, { revision: empty.revision, slides: [{ id: s[1].id, title: "  " }] }), /пустой заголовок/);

  const badOrder = getCarousel(c.id)!;
  assert.throws(() => applyManualEdit(badOrder, { revision: badOrder.revision, order: [s[1].id, s[0].id, s[2].id, s[3].id] }), /Обложка остаётся первой/);
  assert.throws(() => applyManualEdit(badOrder, { revision: badOrder.revision, order: [s[0].id, s[1].id, s[3].id] }), (e: any) => e.status === 409);

  const reorder = getCarousel(c.id)!;
  applyManualEdit(reorder, { revision: reorder.revision, order: [s[0].id, s[2].id, s[1].id, s[3].id] });
  assert.deepEqual(
    reorder.slides.map((x) => x.id),
    [s[0].id, s[2].id, s[1].id, s[3].id],
  );
});

test("готовность к публикации: нужен актуальный рендер каждого слайда и подпись в пределах", () => {
  freshRoot();
  const c = createCarousel(request);
  const s = slides();
  const x = updateCarousel(c.id, (y) => (y.slides = s), { content: true });
  assert.match(publishReadiness(x).join(), /Слайд 1 не отрендерен/);
  for (let i = 0; i < x.slides.length; i++) {
    const hash = slideHash(x, x.slides[i], i, x.slides.length);
    x.slides[i].render = { hash, file: `slide-${x.slides[i].id}-${hash.slice(0, 12)}.jpg`, at: new Date().toISOString() };
  }
  assert.deepEqual(publishReadiness(x), []);
  x.slides[2].title = "Изменили после рендера";
  assert.match(publishReadiness(x).join(), /Слайд 3 не отрендерен после изменений/);
  x.slides[2].title = "Вторая мысль";
  x.caption = "x".repeat(2300);
  assert.match(publishReadiness(x).join(), /Подпись/);
});

test("обработчик каруселей — один: блокировка, перехват зависшей, освобождение", () => {
  freshRoot();
  const now = Date.now();
  assert.equal(acquireRunnerLock(1, now), true);
  assert.equal(acquireRunnerLock(2, now + 1000), false);
  assert.equal(acquireRunnerLock(2, now + RUNNER_STALE_MS + 1000), true);
  assert.equal(touchRunnerLock(1), false);
  releaseRunnerLock(1);
  assert.equal(readRunnerLock()?.pid, 2);
  releaseRunnerLock(2);
  assert.equal(readRunnerLock(), null);
});

test("чистка файлов слайдов оставляет текущие и файлы публикации", () => {
  freshRoot();
  const c = createCarousel(request);
  const s = slides();
  const name = (id: string, h: string) => `slide-${id}-${h.repeat(12)}.jpg`;
  const current = name(s[0].id, "a");
  const published = name(s[1].id, "b");
  const orphan = name(s[2].id, "c");
  s[0].render = { hash: "a", file: current, at: "" };
  updateCarousel(c.id, (x) => {
    x.slides = s;
    x.publish.items = [{ slideId: s[1].id, file: published }];
  });
  fs.mkdirSync(slidesDir(c.id), { recursive: true });
  for (const f of [current, published, orphan]) fs.writeFileSync(slideFilePath(c.id, f), "jpg");
  assert.equal(cleanupSlideFiles(c.id), 1);
  assert.deepEqual(fs.readdirSync(slidesDir(c.id)).sort(), [current, published].sort());
});
