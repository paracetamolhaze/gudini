import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { authCookieValue, checkCarouselAccess } from "../lib/carousel/auth";
import { middleware } from "../middleware";

const req = (url: string, headers: Record<string, string> = {}) => new NextRequest(new URL(url, "http://localhost:3000"), { headers });

test("пароль сайта не задан — раздел закрыт, а не открыт всем", () => {
  const r = checkCarouselAccess(req("/api/carousel"), "");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 403);
    assert.equal(r.code, "login_disabled");
  }
});

test("пароль задан: без входа 401, верная cookie и Basic — доступ, чужая cookie — нет", () => {
  assert.equal(checkCarouselAccess(req("/api/carousel"), "pw").ok, false);
  assert.equal(checkCarouselAccess(req("/api/carousel", { cookie: `gudini_auth=${authCookieValue("pw")}` }), "pw").ok, true);
  assert.equal(checkCarouselAccess(req("/api/carousel", { cookie: `gudini_auth=${authCookieValue("other")}` }), "pw").ok, false);
  assert.equal(checkCarouselAccess(req("/api/carousel", { authorization: `Basic ${Buffer.from("worker:pw").toString("base64")}` }), "pw").ok, true);
  assert.equal(checkCarouselAccess(req("/api/carousel", { authorization: `Basic ${Buffer.from("worker:nope").toString("base64")}` }), "pw").ok, false);
});

test("cookie раздела считается так же, как в middleware и /api/login", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gudini:pw"));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(authCookieValue("pw"), hex);
});

test("middleware: без входа открыты только подписанные слайды; прежние правила не изменились", async () => {
  const prev = process.env.SITE_PASSWORD;
  process.env.SITE_PASSWORD = "pw";
  try {
    const slide = await middleware(req("/api/carousel/public/cabc/slide-x.jpg?exp=1&sig=2"));
    assert.equal(slide.headers.get("x-middleware-next"), "1");

    assert.equal((await middleware(req("/api/carousel"))).status, 401);
    assert.equal((await middleware(req("/api/carousel/cabc/image/slide-x.jpg"))).status, 401);
    assert.equal((await middleware(req("/api/carousel/public/cabc/slide-x.jpg/extra"))).status, 401);
    const page = await middleware(req("/carousel"));
    assert.equal(page.status, 307);
    assert.match(page.headers.get("location") ?? "", /\/login\?next=%2Fcarousel$/);
    const withCookie = await middleware(req("/api/carousel", { cookie: `gudini_auth=${authCookieValue("pw")}` }));
    assert.equal(withCookie.headers.get("x-middleware-next"), "1");

    // регрессия общих правил: готовое видео открыто для Instagram, исходник — нет
    assert.equal((await middleware(req("/api/projects/abc/video"))).headers.get("x-middleware-next"), "1");
    assert.equal((await middleware(req("/api/projects/abc/video?which=raw"))).status, 401);
    assert.equal((await middleware(req("/terms"))).headers.get("x-middleware-next"), "1");
    assert.equal((await middleware(req("/api/projects"))).status, 401);
  } finally {
    if (prev === undefined) delete process.env.SITE_PASSWORD;
    else process.env.SITE_PASSWORD = prev;
  }
});

test("middleware без пароля пропускает всё, как и раньше", async () => {
  const prev = process.env.SITE_PASSWORD;
  delete process.env.SITE_PASSWORD;
  try {
    assert.equal((await middleware(req("/api/projects"))).headers.get("x-middleware-next"), "1");
    assert.equal((await middleware(req("/carousel"))).headers.get("x-middleware-next"), "1");
  } finally {
    if (prev !== undefined) process.env.SITE_PASSWORD = prev;
  }
});
