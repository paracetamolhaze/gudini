import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { extractMediaFromHtml, isProtectedPlatform, isDirectMedia } from "../lib/brollVideo";
import { scoreRelevance, AssetAnalysis } from "../lib/brollRelevance";
import type { VisualIntent } from "../lib/editPlan";

const intent: VisualIntent = {
  subject: "football player",
  action: "playing",
  environment: "stadium",
  mood: "tense",
  mustHave: ["football"],
  avoid: [],
};

test("1: из страницы достаётся вложенное видео, а не скриншот страницы", () => {
  const html = `<html><head>
    <meta property="og:image" content="/img/cover.jpg">
    <meta property="og:video:secure_url" content="https://cdn.news.com/clip.mp4">
    <title>Player injured after match</title></head><body></body></html>`;
  const m = extractMediaFromHtml(html, "https://news.com/article");
  assert.equal(m.video, "https://cdn.news.com/clip.mp4", "видео приоритетнее картинки");
  assert.equal(m.image, "https://news.com/img/cover.jpg", "относительный путь развёрнут");

  // JSON-LD тоже читается
  const ld = `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://a.com/v.mp4"}</script>`;
  assert.equal(extractMediaFromHtml(ld, "https://a.com/p").video, "https://a.com/v.mp4");
});

test("2: скриншот статьи или поста отклоняется как визуал", () => {
  const tweet: AssetAnalysis = {
    description: "a screenshot of a tweet about a football player injury",
    objects: ["screenshot", "tweet", "text", "football"],
    environment: "social media",
    action: "none",
    isScreenshot: true,
    updatedAt: "2026",
  };
  assert.equal(scoreRelevance(intent, tweet).relevance, 0);
  assert.ok(scoreRelevance(intent, tweet).reason.includes("скриншот"));

  const texty: AssetAnalysis = {
    description: "football headline graphic with large text",
    objects: ["football", "text", "headline"],
    environment: "graphic",
    action: "none",
    hasLargeText: true,
    updatedAt: "2026",
  };
  assert.equal(scoreRelevance(intent, texty).relevance, 0);

  const watermarked: AssetAnalysis = {
    description: "football match with a huge agency watermark",
    objects: ["football", "stadium"],
    environment: "stadium",
    action: "playing",
    hasLargeWatermark: true,
    updatedAt: "2026",
  };
  assert.equal(scoreRelevance(intent, watermarked).relevance, 0);
});

test("3: внешнее видео кодируется без звука и с выбранным сегментом", () => {
  const src = fs.readFileSync("lib/brollEntity.ts", "utf8");
  assert.ok(src.includes('"-an"'), "аудио внешнего видео отбрасывается");
  assert.ok(src.includes("pickBestSegment"), "момент внутри видео выбирается");
  assert.ok(src.includes('segmentStart > 0 ? ["-ss"'), "сегмент вырезается со смещением");
});

test("4: платформы не блокируются по домену — решает конкретная ссылка", () => {
  assert.equal(isProtectedPlatform(), false, "блок-листа доменов больше нет");
  // годится всё, что отдаётся обычным запросом как медиафайл
  assert.equal(isDirectMedia("https://v.redd.it/abc/DASH_720.mp4"), true);
  assert.equal(isDirectMedia("https://cdn.news.com/clip.webm?ts=1"), true);
  // ссылка на страницу плеера сама по себе визуалом не является
  assert.equal(isDirectMedia("https://www.youtube.com/watch?v=x"), false);
  assert.equal(isDirectMedia("https://example.com/article"), false);
});

test("5: видео приоритетнее фото при равной релевантности", () => {
  const order = fs.readFileSync("lib/brollWeb.ts", "utf8");
  const videoBlock = order.indexOf("VIDEO-FIRST");
  const imageBlock = order.indexOf("searchOpenverse(q)");
  assert.ok(videoBlock > 0 && imageBlock > videoBlock, "видео собирается раньше изображений");
  assert.ok(order.includes("entityFirst.length) add(entityFirst)"), "портрет человека добавляется последним");
});
