import test from 'node:test';
import assert from 'node:assert/strict';
import { beatStarts } from '../lib/montageRefine';
import type { Word } from '../lib/transcribe';
import './montageEditorial.test';

const beats = [
  { id: 'intro', text: 'Это первый футболист в мире.', visualNeed: 'ENTITY' },
  { id: 'event', text: 'Его уносят с поля на носилках.', visualNeed: 'EXACT_EVENT' },
  { id: 'reaction', text: 'Это уже называют самой нелепой травмой.', visualNeed: 'NONE' },
];
const words: Word[] = [];
let at = 0.5;
for (const beat of beats) {
  for (const word of beat.text.split(/\s+/)) { words.push({ word, start: at, end: at + 0.35 }); at += 0.45; }
  at += 3.5;
}

test("Refine: начало блоков находится по речи; короткие «его», «так» не сдвигают границы", () => {
  const starts = beatStarts(beats, words);
  assert.equal(starts.filter((s) => s != null).length, beats.length, "все блоки найдены");
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! > starts[i - 1]!, "начала возрастают");
});
