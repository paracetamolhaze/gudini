import { test } from "node:test";
import assert from "node:assert/strict";
import { XBrowserClient, XBrowserLayoutChanged, XBrowserLoginRequired, XBrowserUnavailable, type XBrowserSendResult } from "../../src/x/browser/client.js";
import { XBrowserPublisher } from "../../src/x/browser/publisher.js";
import { PublishUnknownStateError, type AttemptRecord, type AttemptStore } from "../../src/platforms/attempts.js";

function memoryStore(): AttemptStore & { rows: Map<string, AttemptRecord> } {
  const rows = new Map<string, AttemptRecord>();
  return {
    rows,
    async get(key) {
      return rows.get(key) ?? null;
    },
    async start(key) {
      if (rows.has(key)) return false;
      rows.set(key, { idempotencyKey: key, status: "STARTED", containerId: null, postId: null, error: null, createdAt: new Date() });
      return true;
    },
    async update(key, patch) {
      const cur = rows.get(key);
      if (cur) rows.set(key, { ...cur, ...patch, error: patch.error === undefined ? null : patch.error });
    },
  };
}

/** A container stand-in: every call is recorded, and each action can be scripted per attempt. */
function fakeContainer(script: Partial<Record<string, Array<unknown | Error>>>) {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const client = {
    calls,
    async call(action: string, body: Record<string, unknown> = {}) {
      calls.push({ action, body });
      const queue = script[action];
      const next = queue?.length ? queue.shift() : undefined;
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`fake container has no answer for ${action}`);
      return next;
    },
    publish(text: string, imagePath: string | null) {
      return this.call("publish", { text, imagePath }) as Promise<XBrowserSendResult>;
    },
    reply(text: string, replyToId: string) {
      return this.call("reply", { text, replyToId }) as Promise<XBrowserSendResult>;
    },
    quote(text: string, quotedId: string) {
      return this.call("quote", { text, quotedId }) as Promise<XBrowserSendResult>;
    },
    recover(text: string, since: Date) {
      return this.call("recover", { text, since: since.toISOString() }) as Promise<{ id: string | null; permalink: string | null }>;
    },
  };
  return client as unknown as XBrowserClient & { calls: typeof calls };
}

const sent = (id: string | null, probe: XBrowserSendResult["probe"]): XBrowserSendResult => ({ id, permalink: id ? `https://x.com/me/status/${id}` : null, submitted: true, probe });

test("a confirmed post is recorded once and never sent again", async () => {
  const store = memoryStore();
  const client = fakeContainer({ publish: [sent("111", "toast")] });
  const publisher = new XBrowserPublisher(client, store);

  const first = await publisher.publish({ key: "k1", kind: "post", text: "привет" });
  assert.equal(first.id, "111");
  assert.equal(first.recovered, false);

  const again = await publisher.publish({ key: "k1", kind: "post", text: "привет" });
  assert.equal(again.id, "111");
  assert.equal(again.recovered, true, "a repeat must come from the attempt record");
  assert.equal(client.calls.filter((c) => c.action === "publish").length, 1, "the click must not happen twice");
});

test("no confirmation: the attempt stays unknown, and the retry adopts the post instead of writing a second one", async () => {
  const store = memoryStore();
  const client = fakeContainer({
    publish: [sent(null, "absent")],
    recover: [{ id: "222", permalink: "https://x.com/me/status/222" }],
  });
  const publisher = new XBrowserPublisher(client, store);

  await assert.rejects(publisher.publish({ key: "k2", kind: "post", text: "текст" }), /подтверждения нет/);
  assert.equal(store.rows.get("k2")?.status, "UNKNOWN");

  const retry = await publisher.publish({ key: "k2", kind: "post", text: "текст" });
  assert.equal(retry.id, "222");
  assert.equal(retry.recovered, true);
  assert.equal(client.calls.filter((c) => c.action === "publish").length, 1, "the late post is adopted, not duplicated");
});

test("a timeline we could not read never licenses a second send", async () => {
  const store = memoryStore();
  const client = fakeContainer({
    publish: [sent(null, "unreadable")],
    recover: [new XBrowserLayoutChanged("X изменил разметку")],
  });
  const publisher = new XBrowserPublisher(client, store);

  await assert.rejects(publisher.publish({ key: "k3", kind: "post", text: "текст" }));
  await assert.rejects(publisher.publish({ key: "k3", kind: "post", text: "текст" }), /разметку/);
  assert.equal(client.calls.filter((c) => c.action === "publish").length, 1);
  assert.match(store.rows.get("k3")?.error ?? "", /publish outcome unknown/);
});

test("an attempt a human must look at is refused, not retried", async () => {
  const store = memoryStore();
  store.rows.set("k4", { idempotencyKey: "k4", status: "FAILED", containerId: null, postId: null, error: "unknown state: X отклонил текст", createdAt: new Date() });
  const client = fakeContainer({});
  await assert.rejects(new XBrowserPublisher(client, store).publish({ key: "k4", kind: "post", text: "текст" }), PublishUnknownStateError);
  assert.equal(client.calls.length, 0);
});

test("a failure before the click leaves the attempt retryable", async () => {
  const store = memoryStore();
  const client = fakeContainer({ publish: [new XBrowserLoginRequired("X просит войти")] });
  await assert.rejects(new XBrowserPublisher(client, store).publish({ key: "k5", kind: "post", text: "текст" }), XBrowserLoginRequired);
  assert.equal(store.rows.get("k5")?.status, "STARTED", "nothing went out, so the next run may simply try again");
});

test("a container that died mid-action is unknown, not failed", async () => {
  const store = memoryStore();
  const client = fakeContainer({ publish: [new XBrowserUnavailable("нет связи")] });
  await assert.rejects(new XBrowserPublisher(client, store).publish({ key: "k6", kind: "post", text: "текст" }), XBrowserUnavailable);
  assert.equal(store.rows.get("k6")?.status, "UNKNOWN");
});

test("long text goes out as a thread, each part on its own key", async () => {
  const store = memoryStore();
  const client = fakeContainer({ publish: [sent("1", "toast")], reply: [sent("2", "toast"), sent("3", "toast")] });
  const publisher = new XBrowserPublisher(client, store);
  const text = `${"а".repeat(270)} ${"б".repeat(270)} ${"в".repeat(200)}`;
  const res = await publisher.publishThread({ key: "t1", kind: "post", text }, 280);
  assert.equal(res.parts, 3);
  assert.equal(res.root.id, "1");
  assert.deepEqual(client.calls.filter((c) => c.action === "reply").map((c) => c.body.replyToId), ["1", "2"], "each part answers the previous one");
  assert.ok(store.rows.has("t1:part2") && store.rows.has("t1:part3"));
});

test("the client turns container answers into the right kind of failure", async () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  await assert.rejects(new XBrowserClient("http://x", "t", reply(409, { error: "вход слетел", kind: "login" })).status(), XBrowserLoginRequired);
  await assert.rejects(new XBrowserClient("http://x", "t", reply(502, { error: "разметка", kind: "layout" })).status(), XBrowserLayoutChanged);
  await assert.rejects(new XBrowserClient("", "t").status(), XBrowserUnavailable);

  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(new XBrowserClient("http://x", "t", unreachable).status(), XBrowserUnavailable);
});

test("the container password is sent, and only to the container", async () => {
  let seen: Record<string, string> = {};
  const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await new XBrowserClient("http://x-browser:43132", "SECRET-VALUE", capture).status();
  assert.equal(seen.Authorization, "Bearer SECRET-VALUE");
});
