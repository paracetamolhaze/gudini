import { test } from "node:test";
import assert from "node:assert/strict";
import { qcReject, AssetAnalysis } from "../lib/brollRelevance";
import { verifySource } from "../lib/storyAssets";
import { resetLedger, recordTokens, recordRequest, recordFlat, summarize } from "../lib/costLedger";
import { StoryResearchPack } from "../lib/storyResearch";

const frame = (patch: Partial<AssetAnalysis>): AssetAnalysis => ({
  description: "soccer players on the pitch",
  objects: ["football", "player"],
  environment: "stadium",
  action: "playing",
  updatedAt: new Date().toISOString(),
  ...patch,
});

const research: StoryResearchPack = {
  storyId: "s1",
  canonicalEvent: "Jordan Henderson injured celebrating at the 2026 FIFA World Cup round of 16",
  eventYear: 2026,
  entities: [
    { id: "e1", name: "Jordan Henderson", type: "PERSON", aliases: [] },
    { id: "e2", name: "FIFA World Cup 2026", type: "EVENT", aliases: ["Чемпионат мира по футболу 2026"] },
  ],
  facts: [],
  sources: [],
} as unknown as StoryResearchPack;

test("1: заставки, призывы канала и реакции блогера отсеиваются", () => {
  assert.match(String(qcReject(frame({ hasChannelPromo: true }))), /призыв канала/);
  assert.match(String(qcReject(frame({ isTitleOrOutroCard: true }))), /заставка/);
  assert.match(String(qcReject(frame({ hasFaceOverlay: true }))), /реакция/);
  assert.match(String(qcReject(frame({ hasLargeText: true }))), /текст/);
  assert.match(String(qcReject(frame({ hasPlayerOrSocialUi: true }))), /интерфейс/);
  // чистый кадр события проходит
  assert.equal(qcReject(frame({})), null);
  // если предмет истории — сам документ, крупный текст допустим
  assert.equal(qcReject(frame({ hasLargeText: true }), { textIsTheSubject: true }), null);
});

test("2: объяснялка и постановка не годятся под фактический блок", () => {
  assert.equal(qcReject(frame({ isStudioExplainer: true })), null, "вне фактического блока это не отказ");
  assert.match(String(qcReject(frame({ isStudioExplainer: true }), { factualBeat: true })), /объяснялка/);
  assert.match(String(qcReject(frame({ isReenactmentOrSkit: true }), { factualBeat: true })), /постановка|скетч/);
});

test("3: материал о другом турнире отклоняется, даже если герой тот же", () => {
  // ровно тот случай, который пропустил прошлый пакет: имя совпало, года в тексте нет
  const ajax = verifySource(
    {
      title: "Jordan Henderson faces controversy after receiving yellow card while benched",
      description: "during Ajax Europa League match",
      sourceUrl: "https://volkstorque.co.uk/jordan-henderson-ajax-europa-league-match",
      publisher: "volkstorque",
    },
    research,
  );
  assert.equal(ajax.ok, false, "другой турнир — другое событие");
  assert.match(ajax.reasons.join(" "), /другом соревновании/);

  // материал того же турнира проходит
  const ok = verifySource(
    { title: "Jordan Henderson stretchered off at the World Cup", description: "", sourceUrl: "https://bbc.com/a" },
    research,
  );
  assert.equal(ok.ok, true);
});

test("4: стоимость собирается по всем провайдерам, счёт провайдера важнее тарифа", () => {
  resetLedger();
  // цена названа провайдером — берём её, а не свою
  recordTokens({ stage: "Beat Matching", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 10_000, outputTokens: 1_000, providerReportedCost: 0.07 });
  // цены нет — считаем по тарифу: 3$/млн вход + 15$/млн выход
  recordTokens({ stage: "Script Beats", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 100_000 });
  recordRequest({ stage: "Media Research", provider: "brave", endpoint: "brave/videos/search" });
  recordFlat({ stage: "Cover Generation", provider: "openrouter", model: "google/gemini-3.1-flash-image", cost: 0.068 });  // обложка — единственное место OpenRouter

  const s = summarize();
  const beats = s.stages.find((x) => x.stage === "Script Beats")!;
  assert.equal(Number(beats.cost.toFixed(4)), 4.5, "3$ вход + 1.5$ выход");
  const match = s.stages.find((x) => x.stage === "Beat Matching")!;
  assert.equal(match.cost, 0.07, "сумма провайдера имеет приоритет над тарифом");
  assert.equal(Number(s.totals.variableApiCost.toFixed(4)), Number((0.07 + 4.5 + 0.005 + 0.068).toFixed(4)));
  assert.equal(s.totals.searchRequests, 1, "Brave считается запросами, а не результатами");
});

test("5: неудачные и повторные вызовы попадают в стоимость", () => {
  resetLedger();
  recordTokens({ stage: "Cover QC", provider: "openrouter", model: "anthropic/claude-haiku-4.5", inputTokens: 2_000, outputTokens: 100, providerReportedCost: 0.01, failed: true });
  recordTokens({ stage: "Cover QC", provider: "openrouter", model: "anthropic/claude-haiku-4.5", inputTokens: 2_000, outputTokens: 100, providerReportedCost: 0.01, retry: true });
  const s = summarize();
  assert.equal(s.totals.failedOrRetryCalls, 2, "оба вызова учтены");
  assert.equal(Number(s.totals.failedOrRetryCost.toFixed(4)), 0.02);
  assert.equal(Number(s.totals.variableApiCost.toFixed(4)), 0.02, "их стоимость входит в итог, иначе цифра занижена");
});
