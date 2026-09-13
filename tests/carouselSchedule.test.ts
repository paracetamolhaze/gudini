import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { formatInZone, isValidTimeZone, monthKey, offsetLabel, utcToZonedLocal, zonedLocalToUtc } from "../lib/carousel/timezone";
import { cancelSchedule, refreshScheduleSnapshot, scheduleTick, setSchedule, syncScheduleWithPublish } from "../lib/carousel/schedule";
import { CarouselError, createCarousel, getCarousel, newId, slideFilePath, slidesDir, updateCarousel } from "../lib/carousel/store";
import { slideHash } from "../lib/carousel/templates";
import type { Carousel, PublishAccount, Slide } from "../lib/carousel/types";

/** Отложенная публикация: часовые пояса, снимок одобренной версии, закреплённый аккаунт, планировщик. */

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-carousel-schedule-"));
  process.env.CAROUSEL_DATA_DIR = dir;
  process.env.CAROUSEL_SCHEDULE_GRACE_MINUTES = "60";
  return dir;
}

const ACCOUNT: PublishAccount = { id: "17841", igUserId: "17841", label: "@main", via: "ig" };
const OTHER: PublishAccount = { id: "99999", igUserId: "99999", label: "@second", via: "ig" };
const NOW = Date.parse("2026-09-13T08:00:00Z");

function fakeJpeg(): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(1350, 5);
  sof.writeUInt16BE(1080, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function ready(): Carousel {
  const c = createCarousel({ idea: "Тест", wishes: "", slideCount: 3, language: "ru", style: "graphite", format: "portrait" });
  const slides: Slide[] = [
    { id: newId("s"), kind: "cover", kicker: "", title: "Обложка", body: "", bullets: [], cta: "" },
    { id: newId("s"), kind: "content", kicker: "", title: "Мысль", body: "Текст", bullets: [], cta: "" },
    { id: newId("s"), kind: "final", kicker: "", title: "Итог", body: "", bullets: [], cta: "Сохрани" },
  ];
  fs.mkdirSync(slidesDir(c.id), { recursive: true });
  return updateCarousel(
    c.id,
    (x) => {
      x.slides = slides;
      x.caption = "Подпись";
      x.hashtags = ["#тест"];
      x.slides.forEach((s, i) => {
        const hash = slideHash(x, s, i, x.slides.length);
        const file = `slide-${s.id}-${hash.slice(0, 12)}.jpg`;
        fs.writeFileSync(slideFilePath(c.id, file), fakeJpeg());
        s.render = { hash, file, width: 1080, height: 1350, bytes: 25, scale: 1, at: new Date().toISOString() };
      });
    },
    { content: true },
  );
}

test("часовые пояса: Asia/Qyzylorda — UTC+5 без перехода, обратное преобразование, несуществующее время", () => {
  assert.equal(isValidTimeZone("Asia/Qyzylorda"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  const t = zonedLocalToUtc("2026-09-14T10:00", "Asia/Qyzylorda");
  assert.equal(t, Date.parse("2026-09-14T05:00:00Z"));
  assert.equal(utcToZonedLocal(t!, "Asia/Qyzylorda"), "2026-09-14T10:00");
  assert.equal(offsetLabel(t!, "Asia/Qyzylorda"), "UTC+5");
  assert.equal(zonedLocalToUtc("2026-01-10T00:30", "Europe/Moscow"), Date.parse("2026-01-09T21:30:00Z"));
  assert.equal(zonedLocalToUtc("2026-07-01T12:00", "Europe/Berlin"), Date.parse("2026-07-01T10:00:00Z"), "летнее время");
  assert.equal(zonedLocalToUtc("2026-03-29T02:30", "Europe/Berlin"), null, "времени в промежутке перевода часов нет");
  assert.equal(zonedLocalToUtc("2026-13-01T10:00", "UTC"), null);
  assert.equal(zonedLocalToUtc("вчера", "UTC"), null);
  assert.match(formatInZone(t!, "Asia/Qyzylorda"), /14 сентября 2026.*10:00 · Asia\/Qyzylorda \(UTC\+5\)/);
  assert.equal(monthKey(Date.parse("2026-09-30T22:00:00Z")), "2026-10", "месяц бюджета — по поясу раздела");
});

test("назначение: снимок текущей версии, закреплённый аккаунт, проверки времени и ревизии", () => {
  freshRoot();
  const c = ready();
  assert.throws(() => setSchedule(c.id, { localTime: "2026-09-13T13:01", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW), (e: CarouselError) => /хотя бы через две минуты/.test(e.message));
  assert.throws(() => setSchedule(c.id, { localTime: "2027-01-01T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW), (e: CarouselError) => /60 дней/.test(e.message));
  assert.throws(() => setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Nowhere/City", account: ACCOUNT, revision: c.revision }, NOW), (e: CarouselError) => e.code === "bad_timezone");
  assert.throws(() => setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision - 1 }, NOW), (e: CarouselError) => e.code === "stale_revision");

  const s = setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW).schedule!;
  assert.equal(s.status, "scheduled");
  assert.equal(s.runAt, "2026-09-14T05:00:00.000Z", "хранится UTC");
  assert.equal(s.localTime, "2026-09-14T10:00");
  assert.equal(s.timeZone, "Asia/Qyzylorda");
  assert.deepEqual(s.account, ACCOUNT);
  assert.equal(s.snapshot.revision, c.revision);
  assert.deepEqual(
    s.snapshot.items.map((i) => i.slideId),
    c.slides.map((x) => x.id),
  );
  assert.equal(s.snapshot.caption, "Подпись\n\n#тест");
  assert.match(s.history[0].text, /Назначено на 14 сентября 2026/);

  // перенос сохраняет id и историю; правка после назначения делает версию в расписании устаревшей
  const moved = setSchedule(c.id, { localTime: "2026-09-15T09:30", timeZone: "Europe/Moscow", account: OTHER, revision: c.revision }, NOW).schedule!;
  assert.equal(moved.id, s.id);
  assert.equal(moved.runAt, "2026-09-15T06:30:00.000Z");
  assert.equal(moved.account.id, OTHER.id);
  assert.equal(moved.history.length, 2);
  const edited = updateCarousel(c.id, (x) => (x.slides[1].title = "Другой заголовок"), { content: true });
  assert.notEqual(edited.schedule!.snapshot.revision, edited.revision);
  assert.throws(() => refreshScheduleSnapshot(c.id, edited.revision, NOW), (e: CarouselError) => e.code === "not_ready", "правка без пересборки карточки — снимок не обновить");
  assert.throws(() => refreshScheduleSnapshot(c.id, edited.revision - 1, NOW), (e: CarouselError) => e.code === "stale_revision");
  const captionOnly = updateCarousel(
    c.id,
    (x) => {
      x.slides[1].title = "Мысль";
      x.caption = "Другая подпись";
    },
    { content: true },
  );
  const refreshed = refreshScheduleSnapshot(c.id, captionOnly.revision, NOW).schedule!;
  assert.equal(refreshed.snapshot.revision, captionOnly.revision);
  assert.equal(refreshed.snapshot.caption, "Другая подпись\n\n#тест");
});

test("отмена и повторное назначение; идущую публикацию отменить нельзя", () => {
  freshRoot();
  const c = ready();
  setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW);
  assert.equal(cancelSchedule(c.id, NOW).schedule!.status, "canceled");
  const again = setSchedule(c.id, { localTime: "2026-09-16T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW).schedule!;
  assert.equal(again.status, "scheduled");
  updateCarousel(c.id, (x) => (x.schedule!.status = "publishing"));
  assert.throws(() => cancelSchedule(c.id, NOW), (e: CarouselError) => e.code === "not_cancelable");
});

test("планировщик: время не пришло — ждёт; пришло — ставит публикацию из снимка с закреплённым аккаунтом; дважды не ставит", () => {
  freshRoot();
  const c = ready();
  setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: OTHER, revision: c.revision }, NOW);
  // после назначения пользователь поправил подпись, но версию в расписании не обновлял
  updateCarousel(c.id, (x) => (x.caption = "Свежая подпись"), { content: true });
  assert.deepEqual(scheduleTick(Date.parse("2026-09-14T04:59:00Z")), { queued: [], missed: [], waiting: [] });
  assert.equal(getCarousel(c.id)!.job, null);

  const r = scheduleTick(Date.parse("2026-09-14T05:00:30Z"));
  assert.deepEqual(r.queued, [c.id]);
  const q = getCarousel(c.id)!;
  assert.equal(q.job?.type, "publish");
  assert.equal(q.job?.params.scheduleId, q.schedule!.id);
  assert.equal(q.schedule!.status, "queued");
  assert.equal(q.publish.status, "queued");
  assert.deepEqual(q.publish.account, OTHER, "публикуется в закреплённый аккаунт, а не в активный");
  assert.equal(q.publish.caption, "Подпись\n\n#тест", "уходит одобренная версия подписи, а не правка после назначения");
  assert.equal(q.publish.revision, q.schedule!.snapshot.revision);
  assert.equal(q.publish.scheduleId, q.schedule!.id);

  const second = scheduleTick(Date.parse("2026-09-14T05:01:00Z"));
  assert.deepEqual(second.queued, [], "повторный тик не ставит вторую публикацию");
  assert.equal(getCarousel(c.id)!.job?.id, q.job?.id);

  // итог публикации отражается в расписании
  const done = updateCarousel(c.id, (x) => {
    x.publish.status = "published";
    x.publish.permalink = "https://www.instagram.com/p/T/";
    syncScheduleWithPublish(x, Date.parse("2026-09-14T05:03:00Z"));
  });
  assert.equal(done.schedule!.status, "published");
  assert.equal(done.schedule!.permalink, "https://www.instagram.com/p/T/");
  assert.match(done.schedule!.history.at(-1)!.text, /Опубликовано/);
});

test("простой сервера: в льготном окне публикация отправляется, позже — просрочена и ждёт человека", () => {
  freshRoot();
  const a = ready();
  const b = ready();
  setSchedule(a.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: a.revision }, NOW);
  setSchedule(b.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: b.revision }, NOW);
  // сервер поднялся через 40 минут — a в окне
  const r1 = scheduleTick(Date.parse("2026-09-14T05:40:00Z"));
  assert.deepEqual(r1.queued.sort(), [a.id, b.id].sort());
  freshRoot();
  const c = ready();
  setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW);
  // сервер поднялся через два часа — просрочено
  const r2 = scheduleTick(Date.parse("2026-09-14T07:00:00Z"));
  assert.deepEqual(r2.missed, [c.id]);
  const m = getCarousel(c.id)!;
  assert.equal(m.schedule!.status, "missed");
  assert.match(m.schedule!.error!, /Сервер не работал/);
  assert.equal(m.job, null, "публикация не отправлялась");
  // просроченную можно переназначить или снять
  assert.equal(cancelSchedule(c.id, Date.parse("2026-09-14T07:01:00Z")).schedule!.status, "canceled");
});

test("если карусель занята заданием в назначенное время — планировщик ждёт следующего тика; опубликованная вручную снимается", () => {
  freshRoot();
  const c = ready();
  setSchedule(c.id, { localTime: "2026-09-14T10:00", timeZone: "Asia/Qyzylorda", account: ACCOUNT, revision: c.revision }, NOW);
  updateCarousel(c.id, (x) => {
    x.job = { id: "jbusy", type: "render", state: "running", step: "Сборка", progress: 50, params: {}, attempts: 1, queuedAt: new Date().toISOString(), heartbeatAt: new Date(Date.parse("2026-09-14T05:00:20Z")).toISOString() };
  });
  const r = scheduleTick(Date.parse("2026-09-14T05:00:30Z"));
  assert.deepEqual(r.waiting, [c.id]);
  assert.equal(getCarousel(c.id)!.schedule!.status, "scheduled");
  updateCarousel(c.id, (x) => {
    x.job = null;
    x.publish.status = "published";
  });
  scheduleTick(Date.parse("2026-09-14T05:01:00Z"));
  assert.equal(getCarousel(c.id)!.schedule!.status, "canceled");
});
