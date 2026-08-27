import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { verifySource, isUsable, buildQueries, VERIFICATION_VERSION } from "../lib/storyAssets";
import type { StoryAsset } from "../lib/storyAssets";
import type { StoryResearchPack } from "../lib/storyResearch";
import { materialize } from "../lib/editPlannerPack";
import type { Word } from "../lib/transcribe";

const research: StoryResearchPack = {
  storyId: "s1",
  topic: "травма на чемпионате мира",
  canonicalEvent: "Jordan Henderson injured celebrating after England beat Mexico at the 2018 World Cup",
  summary: "…",
  eventDate: "2018-07-03",
  eventYear: 2018,
  location: "Moscow",
  entities: [
    { id: "e1", name: "Jordan Henderson", type: "PERSON", aliases: ["Джордан Хендерсон"] },
    { id: "e2", name: "England", type: "TEAM", aliases: ["Англия"] },
  ],
  facts: [{ id: "f1", text: "…", sourceUrls: ["https://apnews.com/a"] }],
  sources: [{ url: "https://apnews.com/a", domain: "apnews.com", type: "NEWS" }],
  createdAt: "2026",
};

function asset(over: Partial<StoryAsset> = {}): StoryAsset {
  return {
    id: "a1",
    mediaType: "IMAGE",
    sourceUrl: "https://apnews.com/a",
    sourceDomain: "apnews.com",
    directUrl: "https://cdn.ap.com/1.jpg",
    relatedEntityIds: ["e1"],
    relatedFactIds: [],
    description: "footballer on the pitch",
    verification: {
      sourceVerified: true,
      visualVerified: true,
      verificationVersion: VERIFICATION_VERSION,
      reasons: [],
    },
    ...over,
  };
}

test("1: provenance доходит от исследования до запросов медиатеки", () => {
  const q = buildQueries(research);
  assert.ok(q.length >= 3, "запросов должно быть несколько");
  const all = q.join(" | ").toLowerCase();
  assert.ok(all.includes("jordan henderson"), "имя участника попало в запрос");
  assert.ok(all.includes("2018"), "год события попал в запрос");
  assert.ok(all.includes("england"), "команда попала в запрос");
  // запрос больше не является пересказом одной фразы озвучки
  assert.ok(q[0] === research.canonicalEvent, "первый запрос — каноническое событие");
});

test("2: материал другого года или без сущностей истории отклоняется", () => {
  const wrongYear = verifySource(
    { title: "Jordan Henderson injured at the 2023 Europa League final", sourceUrl: "https://x/1", description: "" },
    research,
  );
  assert.equal(wrongYear.ok, false, "другой год — другая история");
  assert.ok(wrongYear.reasons[0].includes("год"));

  const noEntity = verifySource(
    { title: "Football match highlights", sourceUrl: "https://x/2", description: "goals and saves" },
    research,
  );
  assert.equal(noEntity.ok, false, "просто футбол — не наша история");

  const good = verifySource(
    { title: "Jordan Henderson celebrates England win, 2018", sourceUrl: "https://apnews.com/a", description: "" },
    research,
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.entityIds, ["e1", "e2"]);
});

test("3: видео ищется раньше картинок", () => {
  const src = fs.readFileSync("lib/storyAssets.ts", "utf8");
  const video = src.indexOf("braveVideos(q)");
  const image = src.indexOf("braveImages(q)");
  const web = src.indexOf("braveWeb(q)");
  assert.ok(video > 0 && image > video, "видео-поиск идёт первым");
  assert.ok(web > image, "веб — последний, только для добора контекста");
  // и обязательно используется отдельный новостной эндпоинт
  assert.ok(fs.readFileSync("lib/storyResearch.ts", "utf8").includes("braveNews("), "новости используются в research");
});

test("4: непроверенный ассет и ассет старой версии правил непригодны", () => {
  assert.equal(isUsable(asset()), true);
  assert.equal(isUsable(asset({ verification: { ...asset().verification, sourceVerified: false } })), false);
  assert.equal(isUsable(asset({ verification: { ...asset().verification, visualVerified: false } })), false);
  assert.equal(
    isUsable(asset({ verification: { ...asset().verification, verificationVersion: VERIFICATION_VERSION - 1 } })),
    false,
    "старая версия проверок не считается проверенной",
  );
});

test("5: планировщик не может поставить материал вне пакета", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-pack-"));
  const words: Word[] = Array.from({ length: 40 }, (_, i) => ({
    word: `слово${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  }));
  // в пакете нет ни одного файла на диске → ни одно событие нематериализуется,
  // но главное: посторонний id отбрасывается ещё до сборки клипа
  const events = await materialize(
    dir,
    [
      { assetId: "ЧУЖОЙ-ID", from: 10, to: 14 },
      { assetId: "a1", from: 20, to: 24 },
    ],
    [asset({ localFile: undefined })],
    words,
    30,
  );
  assert.equal(events.length, 0, "ни выдуманный id, ни ассет без файла не попадают в план");
});
