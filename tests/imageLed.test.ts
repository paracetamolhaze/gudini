import test from "node:test";
import assert from "node:assert/strict";
import { imageLedTopic, beatQueries } from "../lib/storyAssetPack";
import { qcReject, AssetAnalysis } from "../lib/brollRelevance";

const research: any = {
  kind: "EXPLAINER", topic: "что такое блокчейн", entities: [{ id: "e1", name: "blockchain", type: "CONCEPT" }], facts: [],
};
const need: any = {
  beatId: "b2", factIds: [], entities: [], intent: "CONTEXT", importance: "MEDIUM", preferredMedia: "VIDEO",
  visualDescription: "bank ledger database with all money records",
};

test("объясняющая тема — режим иллюстраций; новости и кино — нет", () => {
  delete process.env.MEDIA_IMAGE_LED;
  assert.equal(imageLedTopic("EXPLAINER"), true);
  assert.equal(imageLedTopic("HISTORY"), true);
  assert.equal(imageLedTopic("OTHER"), true);
  assert.equal(imageLedTopic("NEWS_EVENT"), false);
  assert.equal(imageLedTopic("ENTERTAINMENT"), false);
  assert.equal(imageLedTopic(undefined), false);
  process.env.MEDIA_IMAGE_LED = "0";
  assert.equal(imageLedTopic("EXPLAINER"), false);
  delete process.env.MEDIA_IMAGE_LED;
});

test("запросы для объяснения ищут иллюстрации и схемы, а не постеры", () => {
  const qs = beatQueries(research, need);
  assert.ok(qs.length >= 3, qs.join(" | "));
  assert.ok(qs.some((q) => /illustration/.test(q)));
  assert.ok(qs.some((q) => /diagram infographic/.test(q)));
  assert.ok(!qs.some((q) => /official still poster/.test(q)));
});

test("новости: запросы прежние, с годом и событием", () => {
  const news: any = { kind: "NEWS_EVENT", topic: "матч", eventYear: 2026, entities: [{ id: "e", name: "England", type: "EVENT" }], facts: [] };
  const qs = beatQueries(news, { ...need, entities: ["Henderson"] });
  assert.ok(qs.some((q) => /2026/.test(q)));
  assert.ok(!qs.some((q) => /illustration/.test(q)));
});

test("говорящая голова отсеивается в режиме иллюстраций для любого блока", () => {
  const an: AssetAnalysis = {
    description: "man in shirt talking to camera", objects: [], environment: "studio", action: "talking",
    isStudioExplainer: true, updatedAt: "now",
  };
  assert.equal(qcReject(an, { staged: true }), null); // прежнее поведение для нефактических блоков
  assert.match(String(qcReject(an, { staged: true, noTalkingHeads: true })), /говорящая голова/);
});
