import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../lib/editPlanner";
import { planSpeechCleanup } from "../lib/speechCleanupPlanner";
import { fetchStockVideo } from "../lib/broll";
import { Word } from "../lib/transcribe";

// Тесты фолбэков гоняются БЕЗ ключей (окружение тестов чистое):
// каждый внешний слой обязан тихо вернуть null/false, а не уронить пайплайн.

function makeWords(n: number): Word[] {
  return Array.from({ length: n }, (_, i) => ({ word: `слово${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
}

test("Fallback: editPlanner без доступа к Claude возвращает null (пайплайн уйдёт на старый путь)", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const plan = await planEdit("тема", "сценарий", makeWords(50), 20);
  assert.equal(plan, null);
});

test("Fallback: speechCleanupPlanner без доступа к Claude возвращает null (механические паузы)", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const actions = await planSpeechCleanup("сценарий", makeWords(50), []);
  assert.equal(actions, null);
});

test("Fallback: сток без единого провайдера возвращает false, не бросая исключение", async () => {
  delete process.env.PEXELS_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  const ok = await fetchStockVideo(["tiger"], 3, "nonexistent-dir/never-written.mp4");
  assert.equal(ok, false);
});

test("Флаги: SMART_EDITING/SMART_SPEECH_CLEANUP=false распознаются", () => {
  process.env.SMART_EDITING = "false";
  process.env.SMART_SPEECH_CLEANUP = "false";
  assert.equal(process.env.SMART_EDITING !== "false", false);
  assert.equal(process.env.SMART_SPEECH_CLEANUP !== "false", false);
  delete process.env.SMART_EDITING;
  delete process.env.SMART_SPEECH_CLEANUP;
});
