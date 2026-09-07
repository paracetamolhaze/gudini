import test from "node:test";
import assert from "node:assert/strict";
import { todayLine, statusLine, todayBrief } from "../lib/ai";

test("дата передаётся в промпт явно", () => {
  const line = todayLine(new Date("2026-09-07T10:00:00Z"));
  assert.match(line, /Сегодня 2026-09-07/);
  assert.match(line, /уже произошло/);
});

test("статус из исследования формулируется для сценариста", () => {
  assert.match(statusLine({ status: "RELEASED", statusNote: "фильм вышел в прокат 17 июля 2026", eventDate: "2026-07-17" }), /уже вышел.*17 июля 2026.*2026-07-17/);
  assert.match(statusLine({ status: "UPCOMING" }), /ещё не вышел/);
  assert.match(statusLine({}), /не установлен/);
});

test("справка на сегодня: статус и факты без ссылок, пустая без исследования", () => {
  assert.equal(todayBrief(null), "");
  const brief = todayBrief({ status: "RELEASED", statusNote: "фильм вышел 17 июля 2026", facts: [{ id: "f1", text: "Бюджет 250 миллионов", sourceUrls: ["https://x"] }] } as any);
  assert.match(brief, /уже вышел.*17 июля 2026/);
  assert.match(brief, /- Бюджет 250 миллионов/);
  assert.ok(!/https/.test(brief));
});
