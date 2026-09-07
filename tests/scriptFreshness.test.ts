import test from "node:test";
import assert from "node:assert/strict";
import { todayLine, statusLine } from "../lib/ai";

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
