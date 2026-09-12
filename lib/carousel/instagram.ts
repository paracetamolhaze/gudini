import type { PublishState } from "./types";

/**
 * Публикация карусели через Instagram Graph API — без посредников, по документации Meta:
 * контейнер на каждый слайд (is_carousel_item) → контейнер CAROUSEL с детьми в нужном
 * порядке → ожидание status_code=FINISHED → media_publish.
 *
 * Главное — не опубликовать дважды. Каждый шаг сначала записывается в состояние, потом
 * выполняется; повторный запуск (двойное нажатие, перезапуск сайта, повтор после ошибки)
 * продолжает с записанного места и переиспользует созданные контейнеры. После отправки
 * media_publish неясный исход (тайм-аут, обрыв, 5xx) никогда не ведёт к новой отправке
 * вслепую: сначала статус контейнера — PUBLISHED значит пост вышел; FINISHED — не вышел,
 * и повторяется тот же контейнер (новый не создаётся); не удалось проверить — статус
 * «не подтверждено», и дальше только проверка по кнопке.
 *
 * Сеть, часы и сон передаются снаружи — тесты гоняют весь сценарий на поддельном API.
 */

export type GraphAccount = { token: string; igUserId: string; graph: string };

export type IgDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
};

export type IgErrorKind = "auth" | "permission" | "rate_limit" | "media" | "not_ready" | "expired" | "network" | "api";

export class IgError extends Error {
  constructor(
    message: string,
    readonly kind: IgErrorKind,
    /** запрос мог выполниться: ответ не получен или сервер упал */
    readonly uncertain = false,
    readonly code?: number,
  ) {
    super(message);
    this.name = "IgError";
  }
}

export type PublishCtx = {
  load: () => PublishState;
  save: (mutate: (s: PublishState) => void) => PublishState;
  account: GraphAccount;
  mediaUrl: (file: string) => string;
  deps: IgDeps;
};

/** Контейнер живёт 24 часа; старше 23 — создаётся новый. */
const CONTAINER_SAFE_MS = 23 * 3600_000;
/** Опрос статуса: Meta советует не дольше 5 минут. */
export const STATUS_POLL_MS = [3000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000];
/** После отправки даём Instagram время закончить публикацию, прежде чем смотреть статус. */
export const PUBLISH_SETTLE_MS = 20_000;
const MAX_PUBLISH_ATTEMPTS = 3;

export function redact(s: string): string {
  return s.replace(/access_token=[^&\s"']+/gi, "access_token=***").replace(/("access_token"\s*:\s*")[^"]*/gi, "$1***");
}

export function graphError(status: number, err: any, text: string): IgError {
  const code = Number(err?.code);
  const sub = Number(err?.error_subcode);
  const detail = redact(String(err?.error_user_msg || err?.message || text || `HTTP ${status}`))
    .replace(/\s+/g, " ")
    .slice(0, 240);
  if (code === 190) return new IgError(`Токен Instagram недействителен или истёк — переподключите Instagram в Настройках. (${detail})`, "auth", false, code);
  if (code === 10 || code === 3 || (code >= 200 && code < 300)) {
    return new IgError(
      `Нет прав на публикацию: подключению нужно разрешение instagram_business_content_publish (вход через Instagram) или instagram_content_publish (через Facebook). Переподключите Instagram с этим разрешением. (${detail})`,
      "permission",
      false,
      code,
    );
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || sub === 2207042) {
    return new IgError(`Instagram ограничил частоту запросов или исчерпан лимит публикаций за 24 часа — повторите позже. (${detail})`, "rate_limit", false, code);
  }
  if (code === 9007) return new IgError(`Медиа ещё не готово к публикации. (${detail})`, "not_ready", false, code);
  if (code === 9004) return new IgError(`Instagram не смог скачать слайд по публичной ссылке — проверьте, что сайт открывается из интернета по PUBLIC_BASE_URL. (${detail})`, "media", false, code);
  if (code === 100 && sub === 33) return new IgError(`Instagram не принял ID аккаунта — переподключите Instagram в Настройках. (${detail})`, "auth", false, code);
  return new IgError(`Instagram API ${status}: ${detail}`, "api", status >= 500, Number.isFinite(code) ? code : undefined);
}

async function graph(ctx: Pick<PublishCtx, "account" | "deps">, method: "GET" | "POST", pathname: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${ctx.account.graph}/${pathname}`);
  let res: Response;
  try {
    if (method === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set("access_token", ctx.account.token);
      res = await ctx.deps.fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(ctx.deps.timeoutMs) });
    } else {
      res = await ctx.deps.fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, access_token: ctx.account.token }).toString(),
        signal: AbortSignal.timeout(ctx.deps.timeoutMs),
      });
    }
  } catch (e: any) {
    const reason =
      e?.name === "TimeoutError" || e?.name === "AbortError" ? `нет ответа за ${Math.round(ctx.deps.timeoutMs / 1000)} с` : redact(String(e?.message ?? e)).slice(0, 160);
    throw new IgError(`Сетевая ошибка при обращении к Instagram: ${reason}`, "network", true);
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || json?.error) throw graphError(res.status, json?.error, text);
  if (json === null) throw new IgError(`Instagram вернул не JSON (HTTP ${res.status})`, "api", res.status >= 500);
  return json;
}

const toIgError = (e: unknown): IgError => (e instanceof IgError ? e : new IgError(String((e as any)?.message ?? e).slice(0, 300), "api"));

function logLine(s: PublishState, text: string, now: number) {
  s.log = [...(s.log ?? []), { at: new Date(now).toISOString(), text }].slice(-60);
}

const iso = (ms: number) => new Date(ms).toISOString();
const stripContainers = (s: PublishState) => {
  s.items = s.items.map((i) => ({ slideId: i.slideId, file: i.file }));
  s.containerId = undefined;
  s.containerCreatedAt = undefined;
};

/** Публикация уже отправлялась, и её исход не установлен: только проверка, без новых контейнеров. */
export function needsVerification(s: PublishState): boolean {
  return s.stage === "publish_sent" || s.stage === "verifying" || s.status === "uncertain";
}

export async function publishCarousel(ctx: PublishCtx): Promise<PublishState> {
  const now = () => ctx.deps.now();
  let s = ctx.load();
  if (s.status === "published") return s;
  if (needsVerification(s)) return verifyPublication(ctx);

  s = ctx.save((x) => {
    if (x.igUserId && x.igUserId !== ctx.account.igUserId) {
      stripContainers(x);
      logLine(x, "Активный аккаунт Instagram сменился — контейнеры создаются заново", now());
    }
    x.status = "running";
    x.stage = "prepare";
    x.error = undefined;
    x.note = undefined;
    x.retryable = undefined;
    x.igUserId = ctx.account.igUserId;
    logLine(x, "Проверка лимита публикаций", now());
  });

  try {
    if (!s.items.length) throw new IgError("Нет слайдов для публикации", "api");
    await checkQuota(ctx);

    // 1. Контейнер на каждый слайд. id записывается сразу — повторный запуск его переиспользует.
    for (let i = 0; i < s.items.length; i++) {
      const item = ctx.load().items[i];
      const fresh = item.containerId && item.createdAt && now() - Date.parse(item.createdAt) < CONTAINER_SAFE_MS;
      if (fresh) continue;
      ctx.save((x) => {
        x.stage = "children";
        logLine(x, `Контейнер слайда ${i + 1} из ${x.items.length}`, now());
      });
      const r = await graph(ctx, "POST", `${ctx.account.igUserId}/media`, { image_url: ctx.mediaUrl(item.file), is_carousel_item: "true" });
      if (!r?.id) throw new IgError(`Instagram не вернул id контейнера слайда ${i + 1}`, "api");
      ctx.save((x) => {
        x.items[i].containerId = String(r.id);
        x.items[i].createdAt = iso(now());
        // общий контейнер ссылается на прежних детей — после замены ребёнка он недействителен
        x.containerId = undefined;
        x.containerCreatedAt = undefined;
      });
    }
    const children = ctx.load().items;
    for (let i = 0; i < children.length; i++) await waitContainer(ctx, children[i].containerId!, `слайд ${i + 1}`);

    // 2. Контейнер CAROUSEL: дети в порядке слайдов.
    s = ctx.load();
    const parentFresh = s.containerId && s.containerCreatedAt && now() - Date.parse(s.containerCreatedAt) < CONTAINER_SAFE_MS;
    if (!parentFresh) {
      ctx.save((x) => {
        x.stage = "container";
        logLine(x, "Контейнер карусели", now());
      });
      const r = await graph(ctx, "POST", `${ctx.account.igUserId}/media`, {
        media_type: "CAROUSEL",
        children: s.items.map((i) => i.containerId).join(","),
        caption: s.caption ?? "",
      });
      if (!r?.id) throw new IgError("Instagram не вернул id контейнера карусели", "api");
      ctx.save((x) => {
        x.containerId = String(r.id);
        x.containerCreatedAt = iso(now());
      });
    }
    await waitContainer(ctx, ctx.load().containerId!, "карусель");
  } catch (e) {
    // до media_publish ничего не опубликовано: ошибка честная, повтор безопасен
    const err = toIgError(e);
    return ctx.save((x) => {
      x.status = "failed";
      x.stage = undefined;
      x.error = err.message;
      x.retryable = true;
      if (err.kind === "expired" || err.kind === "media") stripContainers(x);
      logLine(x, `Ошибка до отправки публикации: ${err.message}`, now());
    });
  }
  return sendPublish(ctx);
}

async function checkQuota(ctx: PublishCtx) {
  let r: any;
  try {
    r = await graph(ctx, "GET", `${ctx.account.igUserId}/content_publishing_limit`, { fields: "config,quota_usage" });
  } catch (e) {
    const err = toIgError(e);
    // нет прав или токена — дальше идти бессмысленно; прочие сбои лимита не повод отказываться
    if (err.kind === "auth" || err.kind === "permission") throw err;
    return;
  }
  const row = Array.isArray(r?.data) ? r.data[0] : null;
  const usage = Number(row?.quota_usage);
  const total = Number(row?.config?.quota_total);
  if (Number.isFinite(usage) && Number.isFinite(total) && total > 0 && usage >= total) {
    throw new IgError(`Исчерпан лимит Instagram: ${usage} из ${total} публикаций через API за 24 часа. Повторите позже.`, "rate_limit");
  }
}

async function waitContainer(ctx: PublishCtx, id: string, label: string): Promise<void> {
  for (let i = 0; i <= STATUS_POLL_MS.length; i++) {
    const r = await graph(ctx, "GET", id, { fields: "status_code,status" });
    const code = String(r?.status_code ?? "");
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR") throw new IgError(`Instagram не смог обработать ${label}: ${redact(String(r?.status ?? "ERROR")).slice(0, 200)}`, "media");
    if (code === "EXPIRED") throw new IgError(`Контейнер Instagram (${label}) истёк — повторите публикацию`, "expired");
    if (i < STATUS_POLL_MS.length) await ctx.deps.sleep(STATUS_POLL_MS[i]);
  }
  throw new IgError(`Instagram обрабатывает ${label} дольше 5 минут — повторите позже`, "not_ready");
}

async function sendPublish(ctx: PublishCtx): Promise<PublishState> {
  const now = () => ctx.deps.now();
  // отметка «запрос ушёл» пишется ДО запроса: перезапуск после неё ведёт только к проверке
  const s = ctx.save((x) => {
    x.stage = "publish_sent";
    x.status = "running";
    x.publishSentAt = iso(now());
    x.publishAttempts = (x.publishAttempts ?? 0) + 1;
    logLine(x, `Отправлен запрос публикации (попытка ${x.publishAttempts})`, now());
  });
  try {
    const r = await graph(ctx, "POST", `${ctx.account.igUserId}/media_publish`, { creation_id: s.containerId! });
    if (r?.id) return markPublished(ctx, String(r.id));
    return verifyPublication(ctx, new IgError("Instagram не вернул id публикации", "api", true));
  } catch (e) {
    return verifyPublication(ctx, toIgError(e));
  }
}

/** Проверка исхода уже отправленной публикации. Новых контейнеров здесь не бывает. */
export async function verifyPublication(ctx: PublishCtx, cause?: IgError): Promise<PublishState> {
  const now = () => ctx.deps.now();
  let s = ctx.load();
  if (s.status === "published") return s;
  if (!needsVerification(s)) return s;
  if (s.igUserId && s.igUserId !== ctx.account.igUserId) {
    return markUncertain(ctx, "Публикация отправлялась с другого аккаунта Instagram — сделайте его активным в Настройках и проверьте статус снова.");
  }
  if (!s.containerId) {
    return ctx.save((x) => {
      x.status = "failed";
      x.stage = undefined;
      x.retryable = true;
      x.error = "Контейнер карусели не создан — публикация не отправлялась. Можно повторить.";
      logLine(x, x.error, now());
    });
  }
  s = ctx.save((x) => {
    x.stage = "verifying";
    x.status = "running";
    logLine(x, cause ? `Исход не получен (${cause.message}) — проверяю статус контейнера` : "Проверяю статус отправленной публикации", now());
  });

  const sentAt = Date.parse(s.publishSentAt ?? "");
  if (Number.isFinite(sentAt)) {
    const wait = sentAt + PUBLISH_SETTLE_MS - now();
    if (wait > 0) await ctx.deps.sleep(wait);
  }

  let networkFailures = 0;
  for (let i = 0; i <= STATUS_POLL_MS.length; i++) {
    let code = "";
    try {
      code = String((await graph(ctx, "GET", s.containerId!, { fields: "status_code" }))?.status_code ?? "");
    } catch (e) {
      const err = toIgError(e);
      if (err.uncertain && ++networkFailures < 3 && i < STATUS_POLL_MS.length) {
        await ctx.deps.sleep(STATUS_POLL_MS[i]);
        continue;
      }
      return markUncertain(ctx, `Не удалось проверить, вышел ли пост: ${err.message}`);
    }

    if (code === "PUBLISHED") {
      const found = await findPublishedMedia(ctx);
      return markPublished(ctx, found?.id, found?.permalink);
    }
    if (code === "FINISHED") {
      // контейнер готов и не опубликован — поста нет
      if (cause && !cause.uncertain && cause.kind !== "not_ready") {
        return ctx.save((x) => {
          x.status = "failed";
          x.stage = "container";
          x.retryable = true;
          x.error = cause.message;
          logLine(x, "Проверка: пост не вышел, контейнер цел — можно повторить", now());
        });
      }
      if ((ctx.load().publishAttempts ?? 0) >= MAX_PUBLISH_ATTEMPTS) {
        return ctx.save((x) => {
          x.status = "failed";
          x.stage = "container";
          x.retryable = true;
          x.error = `Instagram не опубликовал карусель после ${x.publishAttempts} попыток; проверка показывает, что пост не вышел. Повторите позже.`;
          logLine(x, x.error, now());
        });
      }
      ctx.save((x) => logLine(x, "Проверка: пост не вышел — повторяю публикацию того же контейнера", now()));
      if (cause?.kind === "not_ready") await ctx.deps.sleep(10_000);
      return sendPublish(ctx);
    }
    if (code === "ERROR" || code === "EXPIRED") {
      return ctx.save((x) => {
        x.status = "failed";
        x.stage = undefined;
        x.retryable = true;
        x.error = `Пост не опубликован: контейнер в статусе ${code}${cause ? ` (${cause.message})` : ""}. Можно повторить — контейнеры создадутся заново.`;
        stripContainers(x);
        logLine(x, x.error, now());
      });
    }
    if (i < STATUS_POLL_MS.length) await ctx.deps.sleep(STATUS_POLL_MS[i]);
  }
  return markUncertain(ctx, "Instagram не сообщил итог публикации за 5 минут.");
}

function markUncertain(ctx: PublishCtx, message: string): PublishState {
  return ctx.save((x) => {
    x.status = "uncertain";
    x.stage = "publish_sent";
    x.retryable = false;
    x.error = `${message} Повторная отправка заблокирована, пока статус не проверен: нажмите «Проверить статус» или посмотрите профиль в Instagram.`;
    logLine(x, message, ctx.deps.now());
  });
}

async function markPublished(ctx: PublishCtx, mediaId?: string, permalink?: string): Promise<PublishState> {
  if (mediaId && !permalink) {
    try {
      const r = await graph(ctx, "GET", mediaId, { fields: "permalink" });
      if (typeof r?.permalink === "string") permalink = r.permalink;
    } catch {}
  }
  return ctx.save((x) => {
    x.status = "published";
    x.stage = "done";
    x.mediaId = mediaId ?? x.mediaId;
    x.permalink = permalink ?? x.permalink;
    x.publishedAt = iso(ctx.deps.now());
    x.error = undefined;
    x.retryable = false;
    x.note = permalink ? undefined : "Пост опубликован, но Instagram не вернул ссылку — найдите его в профиле.";
    logLine(x, "Опубликовано", ctx.deps.now());
  });
}

const parseIgTime = (t: unknown) => Date.parse(String(t ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

/** Опубликованный пост по недавним публикациям аккаунта: тип, время и совпадение подписи. */
async function findPublishedMedia(ctx: PublishCtx): Promise<{ id: string; permalink?: string } | null> {
  const s = ctx.load();
  try {
    const r = await graph(ctx, "GET", `${ctx.account.igUserId}/media`, { fields: "id,media_type,permalink,timestamp,caption", limit: "10" });
    const since = Date.parse(s.publishSentAt ?? "") - 15 * 60_000;
    const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
    const items = (Array.isArray(r?.data) ? r.data : []).filter(
      (m: any) => m?.media_type === "CAROUSEL_ALBUM" && (!Number.isFinite(since) || parseIgTime(m.timestamp) >= since),
    );
    const exact = items.find((m: any) => norm(m.caption) === norm(s.caption));
    const pick = exact ?? (items.length === 1 ? items[0] : null);
    return pick?.id ? { id: String(pick.id), permalink: typeof pick.permalink === "string" ? pick.permalink : undefined } : null;
  } catch {
    return null;
  }
}
