import type { Carousel, PublishAccount, ScheduleSnapshot, ScheduleState } from "./types";
import { scheduleGraceMinutes } from "./config";
import { CarouselError, attachJob, isJobPending, listCarousels, newId, updateCarousel } from "./store";
import { publishReadiness } from "./view";
import { composeCaption } from "./text";
import { formatInZone, isValidTimeZone, zonedLocalToUtc } from "./timezone";

/**
 * Отложенная публикация. Пользователь выбирает дату и время в своём часовом поясе, сервер
 * хранит момент в UTC вместе со снимком одобренной версии (файлы карточек и подпись) и
 * закреплённым аккаунтом Instagram. Контейнеры Instagram живут сутки, поэтому создаются
 * только в момент отправки — планировщик ставит обычное задание publish.
 *
 * Простой сервера: задания, чьё время прошло не дальше льготного окна
 * (CAROUSEL_SCHEDULE_GRACE_MINUTES, по умолчанию 60 минут), отправляются при первом же
 * тике после старта; более старые получают статус «просрочено» и ждут решения человека.
 */

export const MIN_AHEAD_MS = 2 * 60_000;
export const MAX_AHEAD_DAYS = 60;

const iso = (ms: number) => new Date(ms).toISOString();

function history(s: ScheduleState, text: string, now: number) {
  s.history = [...(s.history ?? []), { at: iso(now), text }].slice(-40);
  s.updatedAt = iso(now);
}

export function buildSnapshot(c: Carousel, now = Date.now()): ScheduleSnapshot {
  const problems = publishReadiness(c);
  if (problems.length) throw new CarouselError(`Карусель не готова к публикации: ${problems.join("; ")}`, 400, "not_ready");
  return { revision: c.revision, items: c.slides.map((s) => ({ slideId: s.id, file: s.render!.file! })), caption: composeCaption(c.caption, c.hashtags), approvedAt: iso(now) };
}

export const isScheduleActive = (s: ScheduleState | undefined): boolean => Boolean(s && (s.status === "scheduled" || s.status === "queued" || s.status === "publishing" || s.status === "uncertain"));

export type SetScheduleArgs = { localTime: string; timeZone: string; account: PublishAccount; revision: number };

/** Назначить или перенести публикацию. Снимок одобренной версии делается из текущих карточек. */
export function setSchedule(id: string, args: SetScheduleArgs, now = Date.now()): Carousel {
  if (!isValidTimeZone(args.timeZone)) throw new CarouselError("Неизвестный часовой пояс", 400, "bad_timezone");
  const runAt = zonedLocalToUtc(args.localTime, args.timeZone);
  if (runAt === null) throw new CarouselError("Неверные дата или время (или такого времени нет в этом часовом поясе)", 400, "bad_time");
  if (runAt < now + MIN_AHEAD_MS) throw new CarouselError("Время публикации должно быть хотя бы через две минуты. Если нужно сразу — нажмите «Опубликовать сейчас».", 400, "bad_time");
  if (runAt > now + MAX_AHEAD_DAYS * 86_400_000) throw new CarouselError(`Публикацию можно назначить не дальше чем на ${MAX_AHEAD_DAYS} дней: токен Instagram живёт 60 дней`, 400, "bad_time");

  return updateCarousel(id, (c) => {
    if (isJobPending(c.job)) throw new CarouselError("Идёт задание — назначить публикацию можно после его окончания", 409, "busy");
    const p = c.publish;
    if (p.status === "published") throw new CarouselError("Карусель уже опубликована", 409, "already_published");
    if (p.status === "queued" || p.status === "running" || p.status === "uncertain") throw new CarouselError("Публикация выполняется или её исход не подтверждён", 409, "publishing");
    const sc = c.schedule?.status;
    if (sc === "queued" || sc === "publishing" || sc === "uncertain") throw new CarouselError("Запланированная публикация уже выполняется", 409, "publishing");
    if (typeof args.revision !== "number" || args.revision !== c.revision) {
      throw new CarouselError("Карусель изменилась после просмотра — обновите страницу и проверьте слайды перед назначением", 409, "stale_revision");
    }
    const snapshot = buildSnapshot(c, now);
    const prev = c.schedule;
    const moved = prev && prev.status === "scheduled";
    const s: ScheduleState = {
      id: moved ? prev.id : newId("sc"),
      status: "scheduled",
      runAt: iso(runAt),
      timeZone: args.timeZone,
      localTime: args.localTime,
      account: args.account,
      snapshot,
      createdAt: moved ? prev.createdAt : iso(now),
      updatedAt: iso(now),
      history: moved ? prev.history : [],
    };
    history(s, `${moved ? "Перенесено" : "Назначено"} на ${formatInZone(runAt, args.timeZone)}, аккаунт ${args.account.label ?? args.account.igUserId}`, now);
    c.schedule = s;
  });
}

/** Обновить снимок одобренной версии после правок — явным действием пользователя. */
export function refreshScheduleSnapshot(id: string, revision: number, now = Date.now()): Carousel {
  return updateCarousel(id, (c) => {
    const s = c.schedule;
    if (!s || s.status !== "scheduled") throw new CarouselError("Публикация не запланирована", 409, "not_scheduled");
    if (isJobPending(c.job)) throw new CarouselError("Идёт задание — дождитесь его окончания", 409, "busy");
    if (typeof revision !== "number" || revision !== c.revision) throw new CarouselError("Карусель изменилась после просмотра — обновите страницу", 409, "stale_revision");
    s.snapshot = buildSnapshot(c, now);
    history(s, "Версия в расписании обновлена до текущей", now);
  });
}

export function cancelSchedule(id: string, now = Date.now()): Carousel {
  return updateCarousel(id, (c) => {
    const s = c.schedule;
    if (!s) throw new CarouselError("Публикация не запланирована", 409, "not_scheduled");
    if (s.status !== "scheduled" && s.status !== "missed" && s.status !== "failed") {
      throw new CarouselError("Отменить можно только ожидающую, просроченную или неудавшуюся публикацию", 409, "not_cancelable");
    }
    s.status = "canceled";
    history(s, "Снято с расписания", now);
  });
}

/** Публикация по расписанию отражает состояние обычной публикации той же карусели. */
export function syncScheduleWithPublish(c: Carousel, now = Date.now()): void {
  const s = c.schedule;
  const p = c.publish;
  if (!s || !p.scheduleId || p.scheduleId !== s.id) return;
  const map: Record<string, ScheduleState["status"] | undefined> = { queued: "queued", running: "publishing", published: "published", failed: "failed", uncertain: "uncertain" };
  const next = map[p.status];
  if (!next || next === s.status) return;
  s.status = next;
  if (next === "published") {
    s.permalink = p.permalink;
    s.error = undefined;
    history(s, `Опубликовано${p.permalink ? `: ${p.permalink}` : ""}`, now);
  } else if (next === "failed" || next === "uncertain") {
    s.error = p.error;
    history(s, `${next === "failed" ? "Ошибка" : "Исход не подтверждён"}: ${p.error ?? "без описания"}`, now);
  } else history(s, next === "queued" ? "Отправка поставлена в очередь" : "Публикуется", now);
}

export type TickResult = { queued: string[]; missed: string[]; waiting: string[] };

/** Один проход планировщика: назначенные на прошедшее время — в очередь или в просроченные. */
export function scheduleTick(now = Date.now()): TickResult {
  const out: TickResult = { queued: [], missed: [], waiting: [] };
  const grace = scheduleGraceMinutes() * 60_000;
  for (const c of listCarousels()) {
    const s = c.schedule;
    if (!s || s.status !== "scheduled") continue;
    const runAt = Date.parse(s.runAt);
    if (!Number.isFinite(runAt) || runAt > now) continue;
    try {
      updateCarousel(c.id, (x) => {
        const sc = x.schedule;
        if (!sc || sc.id !== s.id || sc.status !== "scheduled") return;
        if (now - runAt > grace) {
          sc.status = "missed";
          sc.error = `Сервер не работал в назначенное время (${formatInZone(runAt, sc.timeZone)}), льготное окно ${scheduleGraceMinutes()} мин прошло. Назначьте новое время или опубликуйте сейчас.`;
          history(sc, "Просрочено: сервер не работал в назначенное время", now);
          out.missed.push(x.id);
          return;
        }
        if (isJobPending(x.job) || x.publish.status === "queued" || x.publish.status === "running" || x.publish.status === "uncertain") {
          out.waiting.push(x.id);
          return;
        }
        if (x.publish.status === "published") {
          sc.status = "canceled";
          history(sc, "Снято с расписания: карусель уже опубликована вручную", now);
          return;
        }
        const p = x.publish;
        const same = p.revision === sc.snapshot.revision && p.caption === sc.snapshot.caption && p.items.length === sc.snapshot.items.length && p.items.every((it, i) => it.slideId === sc.snapshot.items[i].slideId && it.file === sc.snapshot.items[i].file);
        x.publish = {
          ...p,
          status: "queued",
          stage: undefined,
          revision: sc.snapshot.revision,
          caption: sc.snapshot.caption,
          items: same ? p.items : sc.snapshot.items.map((it) => ({ slideId: it.slideId, file: it.file })),
          containerId: same ? p.containerId : undefined,
          containerCreatedAt: same ? p.containerCreatedAt : undefined,
          account: sc.account,
          scheduleId: sc.id,
          igUserId: sc.account.igUserId,
          accountLabel: sc.account.label ?? undefined,
          publishAttempts: 0,
          error: undefined,
          note: undefined,
          retryable: undefined,
          log: [...p.log, { at: iso(now), text: `Публикация по расписанию (${formatInZone(runAt, sc.timeZone)}) поставлена в очередь` }].slice(-60),
        };
        attachJob(x, "publish", { scheduleId: sc.id });
        sc.status = "queued";
        history(sc, "Время пришло — отправка поставлена в очередь", now);
        out.queued.push(x.id);
      });
    } catch (e: any) {
      console.error(`Карусели: планировщик ${c.id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return out;
}

export function scheduleSummary(c: Carousel) {
  const s = c.schedule;
  if (!s) return null;
  const runAt = Date.parse(s.runAt);
  return {
    id: s.id,
    status: s.status,
    runAt: s.runAt,
    timeZone: s.timeZone,
    localTime: s.localTime,
    when: Number.isFinite(runAt) ? formatInZone(runAt, s.timeZone) : s.runAt,
    account: s.account,
    snapshotRevision: s.snapshot.revision,
    stale: s.status === "scheduled" && s.snapshot.revision !== c.revision,
    permalink: s.permalink ?? null,
    error: s.error ?? null,
    history: s.history,
  };
}
