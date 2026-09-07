import test from "node:test";
import assert from "node:assert/strict";
import { rhythmLine } from "../lib/speechProfile";

test("ритм автора попадает в промпт: темп и длина фраз", () => {
  const line = rhythmLine({ wordsPerMinute: 150, sentenceWords: { median: 11, p90: 22 } });
  assert.match(line, /150 слов в минуту/);
  assert.match(line, /138–162/);
  assert.match(line, /в среднем 11 слов, не длиннее 22/);
  assert.equal(rhythmLine(null), "");
});
