import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeLevel, levelGateError, analysisGainDb, transcriptGateError, countScriptWords,
} from "../lib/speechGate";

const script = Array.from({ length: 157 }, (_, i) => `слово${i}`).join(" ");

test("уровень: запись с телесуфлёра на −57 дБ останавливается до платных стадий", () => {
  // 25 с речи на −56, потом шум на −73: как в реальном дубле с iPhone
  const windows = [...Array(25).fill(-56), ...Array(50).fill(-73)];
  const level = analyzeLevel(windows);
  assert.equal(level.loudestDb, -56);
  const err = levelGateError(level);
  assert.ok(err && /почти беззвучная/.test(err), err ?? "no error");
  assert.ok(/-56 дБ/.test(err!), err!);
  assert.ok(/Платные стадии не запускались/.test(err!));
});

test("уровень: запись с камеры (−29 дБ) проходит без усиления", () => {
  const windows = [...Array(20).fill(-28), ...Array(5).fill(-60), ...Array(20).fill(-30)];
  const level = analyzeLevel(windows);
  assert.equal(levelGateError(level), null);
  assert.equal(analysisGainDb(level), 0);
  assert.equal(level.activeSeconds, 40);
  assert.equal(level.lastActiveAt, 45);
});

test("уровень: тихая, но живая запись (−38 дБ) проходит и получает усиление до −25", () => {
  const level = analyzeLevel(Array(30).fill(-38));
  assert.equal(levelGateError(level), null);
  assert.equal(analysisGainDb(level), 13);
});

test("уровень: одиночные щелчки не выдают тихую запись за нормальную", () => {
  const windows = [...Array(60).fill(-58), -20, -18];
  const level = analyzeLevel(windows);
  assert.ok(level.loudestDb < -45, `loudest=${level.loudestDb}`);
  assert.ok(levelGateError(level));
});

test("уровень: пустой замер даёт −100 (вызывающий код сам пропускает ворота без данных)", () => {
  const level = analyzeLevel([]);
  assert.equal(level.loudestDb, -100);
  assert.ok(levelGateError(level));
});

test("расшифровка: 52 слова из 157 в сценарии → стоп с цифрами", () => {
  const words = Array.from({ length: 52 }, (_, i) => ({ start: 0.9 + i * 0.46, end: 1.3 + i * 0.46 }));
  const err = transcriptGateError(words, 75, script);
  assert.ok(err, "expected error");
  assert.match(err!, /52 слов из ~157/);
  assert.match(err!, /33%/);
  assert.match(err!, /до 24\.8 с из 75 с/);
});

test("расшифровка: 120 слов из 157 — норма, ошибки нет", () => {
  const words = Array.from({ length: 120 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4 }));
  assert.equal(transcriptGateError(words, 65, script), null);
});

test("расшифровка: без сценария действует только минимум слов", () => {
  const few = Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 0.5 }));
  assert.match(transcriptGateError(few, 30, "")!, /только 6 слов/);
  const enough = Array.from({ length: 12 }, (_, i) => ({ start: i, end: i + 0.5 }));
  assert.equal(transcriptGateError(enough, 30, ""), null);
});

test("расшифровка: короткий сценарий (<40 слов) не включает долю", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({ start: i, end: i + 0.5 }));
  assert.equal(transcriptGateError(words, 30, "раз два три четыре пять шесть семь восемь девять десять"), null);
});

test("SPEECH_GATE=off отключает обе проверки", () => {
  process.env.SPEECH_GATE = "off";
  try {
    assert.equal(levelGateError(analyzeLevel(Array(20).fill(-70))), null);
    assert.equal(transcriptGateError([], 30, script), null);
  } finally {
    delete process.env.SPEECH_GATE;
  }
});

test("подсчёт слов сценария не считает знаки препинания", () => {
  assert.equal(countScriptWords("Привет, мир — это тест. 2026!"), 5);
});
