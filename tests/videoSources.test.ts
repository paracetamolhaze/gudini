import test from "node:test";
import assert from "node:assert/strict";
import { videoSourcesMode, youtubeId, beatQueries } from "../lib/storyAssetPack";

test("режим источников видео: по умолчанию ролики только запас", () => {
  delete process.env.MEDIA_VIDEO_SOURCES;
  assert.equal(videoSourcesMode(), "fallback");
  process.env.MEDIA_VIDEO_SOURCES = "off";
  assert.equal(videoSourcesMode(), "off");
  process.env.MEDIA_VIDEO_SOURCES = "on";
  assert.equal(videoSourcesMode(), "on");
  process.env.MEDIA_VIDEO_SOURCES = "чушь";
  assert.equal(videoSourcesMode(), "fallback");
  delete process.env.MEDIA_VIDEO_SOURCES;
});

test("идентификатор ролика YouTube из разных ссылок", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://vimeo.com/12345"), null);
});

test("кино: запросы про официальные кадры и постер, без «illustration»", () => {
  const research: any = { kind: "ENTERTAINMENT", topic: "Одиссея Нолана", entities: [{ id: "e", name: "The Odyssey (2026)", type: "EVENT" }], facts: [] };
  const need: any = { beatId: "b", factIds: [], entities: [], intent: "ENTITY", importance: "HIGH", preferredMedia: "IMAGE", visualDescription: "Matt Damon as Odysseus on a ship" };
  const qs = beatQueries(research, need);
  assert.ok(qs.some((q) => /official still/.test(q)), qs.join(" | "));
  assert.ok(qs.some((q) => /poster/.test(q)));
  assert.ok(!qs.some((q) => /illustration/.test(q)));
});
