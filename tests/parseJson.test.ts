import test from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "../lib/mediaLlm";

/**
 * Ответ планировщика с рассуждением перед JSON. Настоящий случай: «Смотрю на историю: это
 * реальное событие…», затем блок ```json на 23 тысячи символов — прежний разбор его терял,
 * и оплаченный план пропадал.
 */

test("рассуждение перед оградой ```json не ломает разбор", () => {
  const raw = 'Смотрю на историю: это реальное событие (Waymo сдало пассажиров). План {черновик} ниже.\n```json\n{"bible": {"events": [{"id": "a"}]}, "beats": [{"fromPhrase": 1}]}\n```';
  const v = parseJson<any>(raw, "t");
  assert.equal(v.beats[0].fromPhrase, 1);
  assert.equal(v.bible.events[0].id, "a");
});

test("без ограды берётся сбалансированный объект, а не текст от первой скобки", () => {
  const raw = 'Заметка {не json} и ответ: {"x": {"y": [1, 2]}, "s": "скобка } в строке"} конец';
  assert.deepEqual(parseJson<any>(raw, "t"), { x: { y: [1, 2] }, s: "скобка } в строке" });
});

test("чистый JSON и JSON в ограде с начала строки разбираются как раньше", () => {
  assert.deepEqual(parseJson<any>('{"a": 1}', "t"), { a: 1 });
  assert.deepEqual(parseJson<any>('```json\n{"a": 2}\n```', "t"), { a: 2 });
});

test("лишняя скобка после списка не обрывает ответ на середине", () => {
  // настоящий случай: «]}, "beats": [...]}» — объект закрыт после событий, дальше идут биты
  const raw = '```json\n{"bible": {"mood": "dry"}, "events": [{"id": "a"}]}, "beats": [{"fromPhrase": 1}]}\n```';
  const v = parseJson<any>(raw, "t");
  assert.equal(v.events[0].id, "a");
  assert.equal(v.beats[0].fromPhrase, 1);
});

test("мусор без JSON остаётся ошибкой стадии", () => {
  assert.throws(() => parseJson("никакого json здесь нет", "AI Film Story"), /AI Film Story: ответ модели не разобрался как JSON/);
});
