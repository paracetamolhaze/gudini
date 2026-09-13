import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

/**
 * Маршруты /api/carousel/* целиком, без сети и без фонового обработчика: временная папка
 * вместо data/, поддельные настройки с «подключённым» Instagram и живая метка обработчика —
 * задания ставятся, но никуда не отправляются. Реальные данные сайта не затрагиваются.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-routes-"));
process.env.CAROUSEL_DATA_DIR = path.join(root, "carousels");
process.env.SITE_PASSWORD = "pw";
// ключ раздела задан (поддельный): без него карусель с иллюстрациями не создаётся; сеть в тестах не трогается
process.env.CAROUSEL_OPENROUTER_API_KEY = "sk-or-test-0000000000";
// lib/store читает data/settings.json от текущей папки: подменяем её до загрузки модулей
process.chdir(root);

const IG_TOKENS = { access_token: "FAKE", ig_user_id: "17841", via: "ig", expires_at: Date.now() + 30 * 86_400_000 };
const IG_SETTINGS = {
  instagramTokens: IG_TOKENS,
  savedAccounts: { instagram: [{ id: "17841", label: "@test_account", at: "", tokens: IG_TOKENS }] },
  activeAccounts: { instagram: "17841" },
  publicBaseUrl: "https://example.test",
};
const writeSettings = (s: object) => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify(s));
};

let store: typeof import("../lib/carousel/store");
let templates: typeof import("../lib/carousel/templates");
let auth: typeof import("../lib/carousel/auth");
let listRoute: typeof import("../app/api/carousel/route");
let itemRoute: typeof import("../app/api/carousel/[id]/route");
let jobsRoute: typeof import("../app/api/carousel/[id]/jobs/route");
let publishRoute: typeof import("../app/api/carousel/[id]/publish/route");
let imageRoute: typeof import("../app/api/carousel/[id]/image/[file]/route");
let archiveRoute: typeof import("../app/api/carousel/[id]/archive/route");
let publicRoute: typeof import("../app/api/carousel/public/[id]/[file]/route");
let scheduleRoute: typeof import("../app/api/carousel/[id]/schedule/route");
let schedulesRoute: typeof import("../app/api/carousel/schedules/route");
let illustrationRoute: typeof import("../app/api/carousel/[id]/illustration/[file]/route");
let designRoute: typeof import("../app/api/carousel/design/route");
let statusRoute: typeof import("../app/api/carousel/status/route");

before(async () => {
  writeSettings(IG_SETTINGS);
  store = await import("../lib/carousel/store");
  templates = await import("../lib/carousel/templates");
  auth = await import("../lib/carousel/auth");
  listRoute = await import("../app/api/carousel/route");
  itemRoute = await import("../app/api/carousel/[id]/route");
  jobsRoute = await import("../app/api/carousel/[id]/jobs/route");
  publishRoute = await import("../app/api/carousel/[id]/publish/route");
  imageRoute = await import("../app/api/carousel/[id]/image/[file]/route");
  archiveRoute = await import("../app/api/carousel/[id]/archive/route");
  publicRoute = await import("../app/api/carousel/public/[id]/[file]/route");
  scheduleRoute = await import("../app/api/carousel/[id]/schedule/route");
  schedulesRoute = await import("../app/api/carousel/schedules/route");
  illustrationRoute = await import("../app/api/carousel/[id]/illustration/[file]/route");
  designRoute = await import("../app/api/carousel/design/route");
  statusRoute = await import("../app/api/carousel/status/route");
  // «живой» обработчик: маршруты не запускают настоящий процесс
  fs.mkdirSync(process.env.CAROUSEL_DATA_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.CAROUSEL_DATA_DIR!, ".runner.json"), JSON.stringify({ pid: 999999, startedAt: "", heartbeatAt: Date.now() + 3600_000 }));
});

const cookie = () => ({ cookie: `gudini_auth=${auth.authCookieValue("pw")}` });
function req(method: string, url: string, body?: unknown, headers: Record<string, string> = cookie()) {
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

function fakeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function readyCarousel() {
  const c = store.createCarousel({ idea: "Как высыпаться", wishes: "", slideCount: 3, language: "ru", style: "graphite", format: "portrait" });
  store.updateCarousel(
    c.id,
    (x) => {
      x.slides = [
        { id: store.newId("s"), kind: "cover", kicker: "", title: "Обложка", body: "", bullets: [], cta: "" },
        { id: store.newId("s"), kind: "content", kicker: "", title: "Мысль", body: "Текст", bullets: [], cta: "" },
        { id: store.newId("s"), kind: "final", kicker: "", title: "Итог", body: "", bullets: [], cta: "Сохрани" },
      ];
      x.caption = "Подпись";
      x.hashtags = ["#тест"];
    },
    { content: true },
  );
  fs.mkdirSync(store.slidesDir(c.id), { recursive: true });
  return store.updateCarousel(c.id, (x) => {
    x.slides.forEach((s, i) => {
      const hash = templates.slideHash(x, s, i, x.slides.length);
      const file = `slide-${s.id}-${hash.slice(0, 12)}.jpg`;
      fs.writeFileSync(store.slideFilePath(c.id, file), fakeJpeg(1080, 1350));
      s.render = { hash, file, width: 1080, height: 1350, bytes: 25, scale: 1, at: new Date().toISOString() };
    });
  });
}

test("с паролем сайта без входа — 401; без пароля раздел открыт, как весь сайт", async () => {
  const c = readyCarousel();
  const file = c.slides[0].render!.file!;
  assert.equal((await listRoute.GET(req("GET", "/api/carousel", undefined, {}))).status, 401);
  assert.equal((await listRoute.POST(req("POST", "/api/carousel", { idea: "Тема" }, {}))).status, 401);
  assert.equal((await publishRoute.POST(req("POST", `/api/carousel/${c.id}/publish`, { revision: c.revision }, {}), params({ id: c.id }))).status, 401);
  assert.equal((await imageRoute.GET(req("GET", `/api/carousel/${c.id}/image/${file}`, undefined, {}), params({ id: c.id, file }))).status, 401);
  assert.equal((await archiveRoute.GET(req("GET", `/api/carousel/${c.id}/archive`, undefined, {}), params({ id: c.id }))).status, 401);

  process.env.SITE_PASSWORD = "";
  try {
    assert.equal((await listRoute.GET(req("GET", "/api/carousel", undefined, {}))).status, 200);
    assert.equal((await imageRoute.GET(req("GET", "x", undefined, {}), params({ id: c.id, file }))).status, 200);
    // открытый доступ не отменяет проверки: чужой путь по-прежнему закрыт
    assert.equal((await imageRoute.GET(req("GET", "x", undefined, {}), params({ id: c.id, file: "../../settings.json" }))).status, 404);
  } finally {
    process.env.SITE_PASSWORD = "pw";
  }
});

test("создание: неверная форма — 400, верная — 201 и фоновое задание генерации", async () => {
  assert.equal((await listRoute.POST(req("POST", "/api/carousel", { idea: "" }))).status, 400);
  assert.equal((await listRoute.POST(req("POST", "/api/carousel", { idea: "Тема", slideCount: 12 }))).status, 400);
  const r = await listRoute.POST(req("POST", "/api/carousel", { idea: "Тема для карусели", slideCount: 5 }));
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const got = await itemRoute.GET(req("GET", `/api/carousel/${id}`), params({ id }));
  const view = await got.json();
  assert.equal(view.carousel.job.type, "generate");
  assert.equal(view.carousel.job.state, "queued");
  assert.equal(view.carousel.request.slideCount, 5);
  // новый сценарий — с иллюстрациями и копией оформления аккаунта; модель по умолчанию
  assert.equal(view.carousel.mode, "illustrated");
  assert.equal(view.carousel.imageModel, "google/gemini-3.1-flash-image");
  assert.equal(view.carousel.imageResolution, "2K");
  assert.ok(view.carousel.design && typeof view.carousel.design.accent === "string");

  // без ключа раздела карусель с иллюстрациями не создаётся — интерфейс получает, какая настройка нужна
  const key = process.env.CAROUSEL_OPENROUTER_API_KEY;
  delete process.env.CAROUSEL_OPENROUTER_API_KEY;
  try {
    const noKey = await listRoute.POST(req("POST", "/api/carousel", { idea: "Тема для карусели" }));
    assert.equal(noKey.status, 400);
    const body = await noKey.json();
    assert.equal(body.code, "config");
    assert.match(body.error, /CAROUSEL_OPENROUTER_API_KEY/);
    // прежние текстовые карточки ключа не требуют
    assert.equal((await listRoute.POST(req("POST", "/api/carousel", { idea: "Тема", mode: "text_cards" }))).status, 201);
  } finally {
    process.env.CAROUSEL_OPENROUTER_API_KEY = key;
  }
});

test("публикация: двойное нажатие и повторный запрос — ровно одно задание", async () => {
  const c = readyCarousel();
  const call = () => publishRoute.POST(req("POST", `/api/carousel/${c.id}/publish`, { revision: c.revision }), params({ id: c.id }));
  const results = await Promise.all([call(), call()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal((await call()).status, 409);
  const saved = store.getCarousel(c.id)!;
  assert.equal(saved.job?.type, "publish");
  assert.equal(saved.publish.status, "queued");
  assert.equal(saved.publish.items.length, 3);
  assert.equal(saved.publish.caption, "Подпись\n\n#тест");
});

test("публикация: устаревшая ревизия, уже опубликовано, неподтверждённый исход", async () => {
  const stale = readyCarousel();
  const r1 = await publishRoute.POST(req("POST", `/api/carousel/${stale.id}/publish`, { revision: stale.revision - 1 }), params({ id: stale.id }));
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).code, "stale_revision");

  const done = readyCarousel();
  store.updateCarousel(done.id, (x) => {
    x.publish.status = "published";
    x.publish.permalink = "https://www.instagram.com/p/X/";
  });
  const r2 = await publishRoute.POST(req("POST", `/api/carousel/${done.id}/publish`, { revision: done.revision }), params({ id: done.id }));
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).code, "already_published");

  const unsure = readyCarousel();
  store.updateCarousel(unsure.id, (x) => {
    x.publish.status = "uncertain";
    x.publish.stage = "publish_sent";
    x.publish.containerId = "carousel1";
  });
  const r3 = await publishRoute.POST(req("POST", `/api/carousel/${unsure.id}/publish`, { revision: unsure.revision }), params({ id: unsure.id }));
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).code, "verify_first");
  const r4 = await publishRoute.POST(req("POST", `/api/carousel/${unsure.id}/publish`, { action: "verify" }), params({ id: unsure.id }));
  assert.equal(r4.status, 202);
  assert.equal(store.getCarousel(unsure.id)!.job?.type, "verify_publish");
});

test("публикация без подключённого Instagram — понятная ошибка, задание не ставится", async () => {
  const c = readyCarousel();
  writeSettings({ publicBaseUrl: "https://example.test" });
  try {
    const r = await publishRoute.POST(req("POST", `/api/carousel/${c.id}/publish`, { revision: c.revision }), params({ id: c.id }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.code, "instagram_unavailable");
    assert.match(body.error, /Instagram не подключён/);
    assert.equal(store.getCarousel(c.id)!.job, null);
  } finally {
    writeSettings(IG_SETTINGS);
  }
});

test("картинки: только свои файлы карусели; обход пути и чужой файл — отказ", async () => {
  const a = readyCarousel();
  const b = readyCarousel();
  const own = a.slides[1].render!.file!;
  const ok = await imageRoute.GET(req("GET", `/api/carousel/${a.id}/image/${own}?download=1`), params({ id: a.id, file: own }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.match(ok.headers.get("content-disposition") ?? "", /slide-02\.jpg/);

  const foreign = b.slides[1].render!.file!;
  assert.equal((await imageRoute.GET(req("GET", "x"), params({ id: a.id, file: foreign }))).status, 404);
  assert.equal((await imageRoute.GET(req("GET", "x"), params({ id: a.id, file: "../../settings.json" }))).status, 404);
  assert.equal((await imageRoute.GET(req("GET", "x"), params({ id: "../../data", file: own }))).status, 404);
});

test("публичная ссылка для Instagram: только подписанный файл из публикации, без входа", async () => {
  const c = readyCarousel();
  const file = c.slides[0].render!.file!;
  const q = new URLSearchParams(store.mediaQuery(c.id, file));
  const get = (f: string, query: string) => publicRoute.GET(req("GET", `/api/carousel/public/${c.id}/${f}?${query}`, undefined, {}), params({ id: c.id, file: f }));

  // файл не стоит в публикации — даже с подписью закрыт
  assert.equal((await get(file, q.toString())).status, 404);
  await publishRoute.POST(req("POST", `/api/carousel/${c.id}/publish`, { revision: c.revision }), params({ id: c.id }));

  const res = await get(file, q.toString());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal((await get(file, "")).status, 404);
  assert.equal((await get(file, `exp=${q.get("exp")}&sig=${"0".repeat(64)}`)).status, 404);
  const other = c.slides[1].render!.file!;
  assert.equal((await get(other, q.toString())).status, 404, "подпись одного файла не открывает другой");
});

test("архив: все слайды по порядку и подпись", async () => {
  const c = readyCarousel();
  const r = await archiveRoute.GET(req("GET", `/api/carousel/${c.id}/archive`), params({ id: c.id }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 4);
  const names = [...zip.toString("latin1").matchAll(/(0[1-3]\.jpg|caption\.txt)/g)].map((m) => m[1]);
  assert.ok(["01.jpg", "02.jpg", "03.jpg", "caption.txt"].every((n) => names.includes(n)));
});

test("правка: текст слайда ставит рендер, старая ревизия — 409, задание блокирует правки", async () => {
  const c = readyCarousel();
  const r = await itemRoute.PATCH(req("PATCH", `/api/carousel/${c.id}`, { revision: c.revision, slides: [{ id: c.slides[1].id, title: "Новая мысль" }] }), params({ id: c.id }));
  assert.equal(r.status, 200);
  const view = await r.json();
  assert.equal(view.carousel.revision, c.revision + 1);
  assert.equal(view.carousel.job.type, "render");
  assert.deepEqual(view.staleSlideIds, [c.slides[1].id]);
  assert.match(view.readiness.join(), /Слайд 2 не собран/);

  const busy = await itemRoute.PATCH(req("PATCH", `/api/carousel/${c.id}`, { revision: view.carousel.revision, caption: "Новая" }), params({ id: c.id }));
  assert.equal(busy.status, 409);

  store.updateCarousel(c.id, (x) => (x.job!.state = "done"));
  const stale = await itemRoute.PATCH(req("PATCH", `/api/carousel/${c.id}`, { revision: c.revision, caption: "Новая" }), params({ id: c.id }));
  assert.equal(stale.status, 409);
});

test("задания: поручение проверяется, повторная генерация готовой карусели запрещена", async () => {
  const c = readyCarousel();
  const short = await jobsRoute.POST(req("POST", "x", { type: "instruct", instruction: "a", revision: c.revision }), params({ id: c.id }));
  assert.equal(short.status, 400);
  const again = await jobsRoute.POST(req("POST", "x", { type: "generate" }), params({ id: c.id }));
  assert.equal(again.status, 409);
  const ok = await jobsRoute.POST(req("POST", "x", { type: "regenerate_slide", slideId: c.slides[1].id, hint: "проще", revision: c.revision }), params({ id: c.id }));
  assert.equal(ok.status, 202);
  assert.equal(store.getCarousel(c.id)!.job?.params.slideId, c.slides[1].id);
});

test("удаление затрагивает только выбранную карусель", async () => {
  const keep = readyCarousel();
  const drop = readyCarousel();
  const r = await itemRoute.DELETE(req("DELETE", "x"), params({ id: drop.id }));
  assert.equal(r.status, 200);
  assert.equal((await itemRoute.GET(req("GET", "x"), params({ id: drop.id }))).status, 404);
  assert.ok(fs.existsSync(store.slideFilePath(keep.id, keep.slides[0].render!.file!)));
  assert.equal((await itemRoute.GET(req("GET", "x"), params({ id: keep.id }))).status, 200);
});

test("публикация закрепляет аккаунт: выбранный в момент нажатия, не активный по умолчанию", async () => {
  const other = { access_token: "FAKE2", ig_user_id: "99999", via: "ig", expires_at: Date.now() + 30 * 86_400_000 };
  writeSettings({ ...IG_SETTINGS, savedAccounts: { instagram: [...IG_SETTINGS.savedAccounts.instagram, { id: "99999", label: "@second", at: "", tokens: other }] } });
  try {
    const c = readyCarousel();
    const r = await publishRoute.POST(req("POST", `/api/carousel/${c.id}/publish`, { revision: c.revision, accountId: "99999" }), params({ id: c.id }));
    assert.equal(r.status, 202);
    const saved = store.getCarousel(c.id)!;
    assert.equal(saved.publish.account?.id, "99999");
    assert.equal(saved.publish.account?.igUserId, "99999");
    assert.equal(saved.publish.igUserId, "99999");
    // смена активного аккаунта в настройках уже не меняет закреплённый
    writeSettings({ ...IG_SETTINGS, activeAccounts: { instagram: "17841" } });
    assert.equal(store.getCarousel(c.id)!.publish.account?.id, "99999");

    const d = readyCarousel();
    const def = await publishRoute.POST(req("POST", `/api/carousel/${d.id}/publish`, { revision: d.revision }), params({ id: d.id }));
    assert.equal(def.status, 202);
    assert.equal(store.getCarousel(d.id)!.publish.account?.id, "17841");
    const e = readyCarousel();
    const unknown = await publishRoute.POST(req("POST", `/api/carousel/${e.id}/publish`, { revision: e.revision, accountId: "nope" }), params({ id: e.id }));
    assert.equal(unknown.status, 400);
  } finally {
    writeSettings(IG_SETTINGS);
  }
});

test("расписание: назначить, обновить версию после правки, снять; публикация «сейчас» снимает расписание", async () => {
  const c = readyCarousel();
  const bad = await scheduleRoute.POST(req("POST", "x", { revision: c.revision, localTime: "2020-01-01T10:00", timeZone: "Asia/Qyzylorda" }), params({ id: c.id }));
  assert.equal(bad.status, 400);
  const local = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);
  const r = await scheduleRoute.POST(req("POST", "x", { revision: c.revision, localTime: local, timeZone: "UTC" }), params({ id: c.id }));
  assert.equal(r.status, 200);
  const view = await r.json();
  assert.equal(view.schedule.status, "scheduled");
  assert.equal(view.schedule.account.id, "17841");
  assert.match(view.schedule.when, /UTC \(UTC\+0\)/);
  assert.equal(view.status.text.startsWith("Запланировано"), true);

  // правка делает версию в расписании устаревшей; снимок обновляется только явным действием
  const edit = await itemRoute.PATCH(req("PATCH", "x", { revision: view.carousel.revision, caption: "Новая подпись" }), params({ id: c.id }));
  const edited = await edit.json();
  assert.equal(edited.schedule.stale, true);
  assert.equal(store.getCarousel(c.id)!.schedule!.snapshot.caption, "Подпись\n\n#тест", "в расписании осталась одобренная подпись");
  const staleRev = await scheduleRoute.POST(req("POST", "x", { action: "refresh", revision: edited.carousel.revision - 1 }), params({ id: c.id }));
  assert.equal(staleRev.status, 409);
  const refreshed = await scheduleRoute.POST(req("POST", "x", { action: "refresh", revision: edited.carousel.revision }), params({ id: c.id }));
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).schedule.stale, false);
  assert.equal(store.getCarousel(c.id)!.schedule!.snapshot.caption, "Новая подпись\n\n#тест");

  const listed = await schedulesRoute.GET(req("GET", "/api/carousel/schedules"));
  const rows = (await listed.json()).schedules;
  assert.ok(rows.some((x: any) => x.carouselId === c.id && x.status === "scheduled"));

  const now = await publishRoute.POST(req("POST", "x", { revision: edited.carousel.revision }), params({ id: c.id }));
  assert.equal(now.status, 202);
  assert.equal(store.getCarousel(c.id)!.schedule!.status, "canceled");
  const cancelAgain = await scheduleRoute.DELETE(req("DELETE", "x"), params({ id: c.id }));
  assert.equal(cancelAgain.status, 409);
});

test("иллюстрации: файл версии отдаётся только со входом и только свой; чужой — 404; правка текста без генератора", async () => {
  const c = readyCarousel();
  const vid = store.newId("v");
  const file = `img-${c.slides[0].id}-${vid}.png`;
  fs.mkdirSync(store.imagesDir(c.id), { recursive: true });
  fs.writeFileSync(store.imageFilePath(c.id, file), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  store.updateCarousel(c.id, (x) => {
    x.mode = "illustrated";
    x.slides[0].image = {
      brief: "scene",
      composition: "",
      textPlacement: "bottom",
      versions: [{ id: vid, file, mediaType: "image/png", width: 1, height: 1, bytes: 12, model: "google/gemini-3.1-flash-image", resolution: "2K", kind: "generate", prompt: "p", references: [], cost: 0.1, estimated: false, at: "" }],
      currentId: vid,
      rev: 0,
      status: "ready",
      attempts: 1,
    };
  });
  const ok = await illustrationRoute.GET(req("GET", "x"), params({ id: c.id, file }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal((await illustrationRoute.GET(req("GET", "x", undefined, {}), params({ id: c.id, file }))).status, 401);
  const other = readyCarousel();
  assert.equal((await illustrationRoute.GET(req("GET", "x"), params({ id: other.id, file }))).status, 404);
  assert.equal((await illustrationRoute.GET(req("GET", "x"), params({ id: c.id, file: "../carousel.json" }))).status, 404);

  // правка текста и место текста — без обращения к генератору, только пересборка карточки
  const cur = store.getCarousel(c.id)!;
  const r = await itemRoute.PATCH(req("PATCH", "x", { revision: cur.revision, slides: [{ id: cur.slides[0].id, title: "Новый заголовок", textPlacement: "top" }] }), params({ id: c.id }));
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.carousel.job.type, "render");
  assert.equal(v.carousel.slides[0].image.textPlacement, "top");
  assert.equal(v.carousel.slides[0].image.rev, 1);
  // задание «иллюстрации» у текстовой карусели — отказ
  const t = readyCarousel();
  const noImg = await jobsRoute.POST(req("POST", "x", { type: "images", revision: t.revision }), params({ id: t.id }));
  assert.equal(noImg.status, 400);
});

test("оформление: чтение, правка, проверка цветов; статус раздела без секретов", async () => {
  const d = await designRoute.GET(req("GET", "x"));
  assert.equal(d.status, 200);
  assert.equal((await d.json()).design.titleFont, "display");
  const bad = await designRoute.PATCH(req("PATCH", "x", { accent: "red" }));
  assert.equal(bad.status, 400);
  const okd = await designRoute.PATCH(req("PATCH", "x", { accent: "#ff8800", author: "@gudini", illustrationStyle: "мягкий 3D" }));
  assert.equal(okd.status, 200);
  const saved = (await okd.json()).design;
  assert.equal(saved.accent, "#FF8800");
  assert.equal(saved.author, "@gudini");

  const st = await statusRoute.GET(req("GET", "x"));
  assert.equal(st.status, 200);
  const text = await st.text();
  assert.ok(!text.includes(process.env.CAROUSEL_OPENROUTER_API_KEY!), "ключ раздела не попадает в ответ статуса");
  const body = JSON.parse(text);
  assert.equal(body.config.keySet, true);
  assert.equal(body.timeZone, "Asia/Qyzylorda");
  assert.ok(Array.isArray(body.models) && body.models.length === 3);
  assert.equal(body.design.author, "@gudini");
});
