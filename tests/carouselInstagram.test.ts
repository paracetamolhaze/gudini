import { test } from "node:test";
import assert from "node:assert/strict";
import { graphError, publishCarousel, redact, verifyPublication, type PublishCtx } from "../lib/carousel/instagram";
import type { PublishState } from "../lib/carousel/types";

/**
 * Публикация карусели на поддельном Graph API: настоящие запросы в Instagram не уходят.
 * Подделка ведёт себя как Meta — контейнер публикуется один раз, статус PUBLISHED после
 * публикации, лента медиа отдаёт опубликованный пост.
 */

type PublishMode = "ok" | "timeout-after-publish" | "timeout-before-publish" | "500-after-publish" | "503-before-publish" | "error-100";
type Opts = {
  publish?: PublishMode[];
  quotaUsage?: number;
  quotaError?: Record<string, unknown>;
  childStatus?: string;
  childCreateError?: Record<string, unknown>;
  carouselCreateFail?: number;
  statusNetworkFail?: boolean;
};

const IG = "17841";

function setup(opts: Opts = {}, files = ["slide-a.jpg", "slide-b.jpg", "slide-c.jpg"]) {
  let clock = Date.parse("2026-09-13T10:00:00Z");
  let seq = 1000;
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  const containers = new Map<string, { status: string; kind: "child" | "carousel"; children?: string[]; imageUrl?: string; caption?: string; published?: boolean }>();
  let published: { id: string; caption: string; at: number } | null = null;
  let publishCalls = 0;
  let carouselCreates = 0;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const params: Record<string, string> = method === "GET" ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const path = url.pathname.replace(/^\/v25\.0\//, "");
    calls.push({ method, path, params });
    assert.equal(params.access_token, "TOKEN");

    if (method === "GET" && path === `${IG}/content_publishing_limit`) {
      if (opts.quotaError) return json(400, { error: opts.quotaError });
      return json(200, { data: [{ quota_usage: opts.quotaUsage ?? 3, config: { quota_total: 100, quota_duration: 86400 } }] });
    }
    if (method === "POST" && path === `${IG}/media` && params.is_carousel_item === "true") {
      if (opts.childCreateError) return json(400, { error: opts.childCreateError });
      const id = `child${seq++}`;
      containers.set(id, { status: opts.childStatus ?? "FINISHED", kind: "child", imageUrl: params.image_url });
      return json(200, { id });
    }
    if (method === "POST" && path === `${IG}/media` && params.media_type === "CAROUSEL") {
      carouselCreates++;
      if (opts.carouselCreateFail && carouselCreates <= opts.carouselCreateFail) return json(500, { error: { message: "temporary", code: 2 } });
      const children = params.children.split(",");
      for (const ch of children) assert.equal(containers.get(ch)?.kind, "child", `контейнер ребёнка ${ch} существует`);
      const id = `carousel${seq++}`;
      containers.set(id, { status: "FINISHED", kind: "carousel", children, caption: params.caption });
      return json(200, { id });
    }
    if (method === "POST" && path === `${IG}/media_publish`) {
      publishCalls++;
      const mode = opts.publish?.[publishCalls - 1] ?? "ok";
      const cont = containers.get(params.creation_id);
      assert.equal(cont?.kind, "carousel", "публикуется контейнер карусели");
      const doPublish = () => {
        if (cont!.published) return json(400, { error: { message: "Media already published", code: 100 } });
        cont!.published = true;
        published = { id: "media777", caption: cont!.caption ?? "", at: clock };
        return null;
      };
      if (mode === "ok") return doPublish() ?? json(200, { id: "media777" });
      if (mode === "timeout-after-publish") {
        doPublish();
        throw timeout();
      }
      if (mode === "timeout-before-publish") throw timeout();
      if (mode === "500-after-publish") {
        doPublish();
        return json(500, { error: { message: "internal", code: 1 } });
      }
      if (mode === "503-before-publish") return json(503, { error: { message: "unavailable", code: 2 } });
      return json(400, { error: { message: "Invalid parameter", code: 100 } });
    }
    if (method === "GET" && containers.has(path)) {
      // сеть пропадает уже после отправки публикации — ровно тот случай, когда исход неизвестен
      if (opts.statusNetworkFail && publishCalls > 0) throw new TypeError("fetch failed");
      const cont = containers.get(path)!;
      return json(200, { id: path, status_code: cont.published ? "PUBLISHED" : cont.status });
    }
    if (method === "GET" && path === `${IG}/media`) {
      const p = published as { id: string; caption: string; at: number } | null;
      return json(200, {
        data: p ? [{ id: p.id, media_type: "CAROUSEL_ALBUM", permalink: "https://www.instagram.com/p/TEST/", timestamp: new Date(p.at).toISOString().replace(/\.\d+Z$/, "+0000"), caption: p.caption }] : [],
      });
    }
    if (method === "GET" && path === "media777") return json(200, { id: "media777", permalink: "https://www.instagram.com/p/TEST/" });
    return json(404, { error: { message: `unexpected ${method} ${path}`, code: 803 } });
  }) as typeof fetch;

  let state: PublishState = {
    status: "queued",
    items: files.map((file, i) => ({ slideId: `s${i}`, file })),
    caption: "Подпись поста\n\n#тест",
    publishAttempts: 0,
    log: [],
  };
  let crashAtStage: string | null = null;

  const ctx: PublishCtx = {
    load: () => structuredClone(state),
    save: (mutate) => {
      const next = structuredClone(state);
      mutate(next);
      state = next;
      if (crashAtStage && next.stage === crashAtStage) {
        crashAtStage = null;
        throw new Error("процесс остановлен");
      }
      return structuredClone(state);
    },
    account: { token: "TOKEN", igUserId: IG, graph: "https://graph.instagram.com/v25.0" },
    mediaUrl: (file) => `https://site.example/api/carousel/public/c1/${file}?exp=1&sig=x`,
    deps: {
      fetch: fetchImpl,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 60_000,
    },
  };

  return {
    ctx,
    opts,
    calls,
    state: () => state,
    setState: (s: PublishState) => (state = s),
    publishCalls: () => publishCalls,
    carouselCreates: () => carouselCreates,
    childCreates: () => calls.filter((c) => c.method === "POST" && c.params.is_carousel_item === "true").length,
    crashAt: (stage: string) => (crashAtStage = stage),
  };
}

const requeue = (s: PublishState): PublishState => ({ ...s, status: "queued", stage: undefined, publishAttempts: 0, error: undefined });

test("успех: слайды по порядку, контейнер карусели, одна публикация, ссылка на пост", async () => {
  const env = setup();
  const result = await publishCarousel(env.ctx);
  assert.equal(result.status, "published");
  assert.equal(result.permalink, "https://www.instagram.com/p/TEST/");
  assert.equal(result.mediaId, "media777");
  assert.equal(env.publishCalls(), 1);

  const children = env.calls.filter((c) => c.params.is_carousel_item === "true");
  assert.deepEqual(
    children.map((c) => c.params.image_url.match(/slide-\w\.jpg/)?.[0]),
    ["slide-a.jpg", "slide-b.jpg", "slide-c.jpg"],
  );
  const carousel = env.calls.find((c) => c.params.media_type === "CAROUSEL")!;
  assert.equal(carousel.params.children, result.items.map((i) => i.containerId).join(","));
  assert.equal(carousel.params.caption, "Подпись поста\n\n#тест");
  assert.ok(!JSON.stringify(result).includes("TOKEN"), "токен не попадает в состояние");

  // повторный запуск (двойное нажатие, перезапуск) после успеха ничего не отправляет
  const before = env.calls.length;
  assert.equal((await publishCarousel(env.ctx)).status, "published");
  assert.equal(env.calls.length, before);
});

test("тайм-аут media_publish, а пост вышел: проверка находит его, вторая отправка не делается", async () => {
  const env = setup({ publish: ["timeout-after-publish"] });
  const result = await publishCarousel(env.ctx);
  assert.equal(result.status, "published");
  assert.equal(result.permalink, "https://www.instagram.com/p/TEST/");
  assert.equal(env.publishCalls(), 1);
});

test("5xx на media_publish, а пост вышел: тоже без второй отправки", async () => {
  const env = setup({ publish: ["500-after-publish"] });
  assert.equal((await publishCarousel(env.ctx)).status, "published");
  assert.equal(env.publishCalls(), 1);
});

test("тайм-аут до публикации: проверка видит FINISHED и повторяет тот же контейнер, новый не создаётся", async () => {
  const env = setup({ publish: ["timeout-before-publish", "ok"] });
  const result = await publishCarousel(env.ctx);
  assert.equal(result.status, "published");
  assert.equal(env.publishCalls(), 2);
  assert.equal(env.carouselCreates(), 1);
  const ids = env.calls.filter((c) => c.path.endsWith("media_publish")).map((c) => c.params.creation_id);
  assert.equal(new Set(ids).size, 1, "обе отправки — один и тот же контейнер");
});

test("перезапуск после отметки «запрос ушёл»: сначала проверка, контейнеры не пересоздаются", async () => {
  const env = setup();
  env.crashAt("publish_sent");
  await assert.rejects(publishCarousel(env.ctx), /процесс остановлен/);
  assert.equal(env.state().stage, "publish_sent");
  assert.equal(env.publishCalls(), 0);

  const result = await publishCarousel(env.ctx);
  assert.equal(result.status, "published");
  assert.equal(env.publishCalls(), 1);
  assert.equal(env.carouselCreates(), 1);
  assert.equal(env.childCreates(), 3);
  assert.ok(result.log.some((l) => /Проверяю статус отправленной публикации/.test(l.text)));
});

test("исход не проверить: «не подтверждено», повторные запуски не отправляют пост, проверка после восстановления сети завершает", async () => {
  const env = setup({ publish: ["timeout-before-publish", "ok"], statusNetworkFail: true });
  const first = await publishCarousel(env.ctx);
  assert.equal(first.status, "uncertain");
  assert.equal(first.retryable, false);
  assert.match(first.error ?? "", /Проверить статус/);
  assert.equal(env.publishCalls(), 1);

  const again = await publishCarousel(env.ctx);
  assert.equal(again.status, "uncertain");
  assert.equal(env.publishCalls(), 1, "повторный запуск не отправил публикацию вслепую");
  assert.equal(env.carouselCreates(), 1);

  env.opts.statusNetworkFail = false;
  const verified = await verifyPublication(env.ctx);
  assert.equal(verified.status, "published");
  assert.equal(env.publishCalls(), 2);
});

test("определённая ошибка Meta на media_publish при FINISHED: ошибка без повтора, потом ручной повтор переиспользует контейнеры", async () => {
  const env = setup({ publish: ["error-100", "ok"] });
  const failed = await publishCarousel(env.ctx);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(env.publishCalls(), 1);

  env.setState(requeue(env.state()));
  const result = await publishCarousel(env.ctx);
  assert.equal(result.status, "published");
  assert.equal(env.childCreates(), 3);
  assert.equal(env.carouselCreates(), 1);
});

test("503 до публикации: проверка видит FINISHED и повторяет", async () => {
  const env = setup({ publish: ["503-before-publish", "ok"] });
  assert.equal((await publishCarousel(env.ctx)).status, "published");
  assert.equal(env.publishCalls(), 2);
});

test("нет прав: понятная ошибка, в Instagram ничего не создано", async () => {
  const env = setup({ quotaError: { message: "Application does not have permission for this action", code: 10 } });
  const r = await publishCarousel(env.ctx);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /instagram_business_content_publish/);
  assert.equal(env.childCreates(), 0);
  assert.equal(env.publishCalls(), 0);
});

test("истёкший токен: просьба переподключить Instagram", async () => {
  const env = setup({ childCreateError: { message: "Error validating access token", code: 190 } });
  const r = await publishCarousel(env.ctx);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /переподключите Instagram/);
});

test("исчерпан лимит 100 публикаций: ошибка до создания контейнеров", async () => {
  const env = setup({ quotaUsage: 100 });
  const r = await publishCarousel(env.ctx);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /лимит/);
  assert.equal(env.childCreates(), 0);
});

test("Instagram не обработал слайд: ошибка, контейнеры сброшены для чистого повтора", async () => {
  const env = setup({ childStatus: "ERROR" });
  const r = await publishCarousel(env.ctx);
  assert.equal(r.status, "failed");
  assert.ok(r.items.every((i) => !i.containerId));
  assert.equal(env.publishCalls(), 0);
});

test("сбой создания контейнера карусели: повтор не создаёт детей заново", async () => {
  const env = setup({ carouselCreateFail: 1 });
  const failed = await publishCarousel(env.ctx);
  assert.equal(failed.status, "failed");
  assert.equal(env.childCreates(), 3);
  env.setState(requeue(env.state()));
  const r = await publishCarousel(env.ctx);
  assert.equal(r.status, "published");
  assert.equal(env.childCreates(), 3);
  assert.equal(env.carouselCreates(), 2);
});

test("контейнеры старше 23 часов и смена аккаунта — создаются заново", async () => {
  const env = setup();
  const old = new Date(Date.parse("2026-09-12T09:00:00Z")).toISOString();
  env.setState({ ...env.state(), igUserId: IG, items: env.state().items.map((i, k) => ({ ...i, containerId: `stale${k}`, createdAt: old })), containerId: "staleCarousel", containerCreatedAt: old });
  assert.equal((await publishCarousel(env.ctx)).status, "published");
  assert.equal(env.childCreates(), 3);

  const other = setup();
  other.setState({ ...other.state(), igUserId: "otheraccount", items: other.state().items.map((i, k) => ({ ...i, containerId: `foreign${k}`, createdAt: "2026-09-13T09:59:00Z" })) });
  assert.equal((await publishCarousel(other.ctx)).status, "published");
  assert.equal(other.childCreates(), 3);
});

test("токен вычищается из сообщений об ошибках", () => {
  assert.equal(redact("https://graph.instagram.com/x?access_token=SECRET123&fields=a"), "https://graph.instagram.com/x?access_token=***&fields=a");
  const e = graphError(400, { message: 'bad {"access_token":"SECRET"}', code: 1 }, "");
  assert.ok(!e.message.includes("SECRET"));
});
