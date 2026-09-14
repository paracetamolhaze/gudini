import test from 'node:test';
import assert from 'node:assert/strict';
import { refineMontage } from '../lib/montageRefine';
import { validateMontage } from '../lib/montageValidator';
import { computeStats, planSemanticSequence, locateQuote } from '../lib/creativeDirector';
import { cardAboveHead } from '../lib/topInset';

test('smaller card stays above the crown with movement clearance', () => {
  for (const top of [340, 450, 560, 800]) {
    const c = cardAboveHead(top);
    assert.ok(c.y + c.h <= top - 72);
    assert.ok(c.w <= 780 && c.w >= 320);
    assert.equal(c.x * 2 + c.w, 1080);
  }
  assert.throws(() => cardAboveHead(200), /недостаточно/);
  assert.throws(() => cardAboveHead(NaN), /Некорректная/);
});

test('returning to an earlier image is rejected even with a semantic explanation', () => {
  const words = ['один', 'кадр', 'новый', 'предмет', 'опять', 'машина'].map((word, i) => ({ word, start: i, end: i + 0.5 }));
  const placements = [
    { assetId: 'taxi', quote: 'один кадр', visualPurpose: 'введение' },
    { assetId: 'blaster', quote: 'новый предмет', visualPurpose: 'предмет' },
    { assetId: 'taxi', quote: 'опять машина', visualPurpose: 'возвращение к машине' },
  ];
  assert.throws(() => planSemanticSequence(placements, { assets } as any, words, 8), /Повтор/);
});

const assets: any[] = ['taxi', 'blaster'].map(id => ({ id, kind: 'IMAGE', file: id + '.jpg', role: 'CONTEXT', beatScores: { [id]: 2 }, verification: { sourceVerified: true, visualVerified: true } }));
const events: any[] = [
  { type: 'EXTERNAL_IMAGE', assetId: 'taxi', beatId: 'taxi', start: 0, end: 14, quote: 'Беспилотное такси', visualPurpose: 'Познакомить с автомобилем, пока вводится ситуация', layout: 'smart_crop', role: 'CONTEXT' },
  { type: 'EXTERNAL_IMAGE', assetId: 'blaster', beatId: 'blaster', start: 14, end: 25, quote: 'Игрушечный пистолет', visualPurpose: 'Показать новый предмет и его боеприпасы', layout: 'smart_crop', role: 'CONTEXT' },
];
const plan = { version: 3 as const, duration: 25, events, stats: computeStats(events, 25, []) };

test('continuous visual track keeps the model’s semantic durations, including long episodes', () => {
  const r = refineMontage({ montage: plan, pack: { assets } as any, duration: 25,
    beats: [{ id: 'taxi', text: 'Беспилотное такси', visualNeed: 'CONTEXT' }, { id: 'blaster', text: 'Игрушечный пистолет', visualNeed: 'GENERAL' }], needs: [],
    words: [{ word: 'Беспилотное', start: 0.1, end: 1 }, { word: 'такси', start: 1, end: 2 }, { word: 'Игрушечный', start: 14, end: 15 }, { word: 'пистолет', start: 15, end: 16 }] });
  assert.deepEqual(r.plan.events, events);
  assert.equal(r.plan.stats.externalCoverage, 1);
});

test('production allows an author-only hook, then requires continuous pictures', () => {
  assert.equal(validateMontage(plan, { assets } as any).ok, true);
  assert.equal(validateMontage({ ...plan, events: [{ ...events[0], start: 3 }, events[1]] }, { assets } as any).ok, true);
  assert.equal(validateMontage({ ...plan, events: [events[0], { ...events[1], assetId: 'taxi' }] }, { assets } as any).ok, false);
  for (const bad of [[], [{ ...events[0], start: 3 }], [{ ...events[0], end: 13 }, events[1]], [events[0], { ...events[1], end: 24 }]]) {
    assert.equal(validateMontage({ ...plan, events: bad }, { assets } as any).ok, false);
  }
});

test('semantic quote boundaries determine durations without a timer or automatic extra cuts', () => {
  const words = [{ word: 'Беспилотное', start: 0.1, end: 1 }, { word: 'такси', start: 1, end: 2 }, { word: 'Игрушечный', start: 14, end: 15 }, { word: 'пистолет', start: 15, end: 16 }];
  const placements = events.map(e => ({ assetId: e.assetId, beatId: e.beatId, quote: e.quote, visualPurpose: e.visualPurpose }));
  const p = planSemanticSequence(placements, { assets } as any, words, 25);
  assert.deepEqual(p.events.map(e => [e.start, e.end]), [[0, 14], [14, 25]]);
  assert.equal(p.events.length, placements.length);
  assert.equal(planSemanticSequence(placements.slice(1), { assets } as any, words, 25).events[0].start, 14);
  assert.throws(() => planSemanticSequence([{ ...placements[0], assetId: 'missing' }], { assets } as any, words, 25), /Неизвестная/);
  assert.throws(() => planSemanticSequence([{ ...placements[0], visualPurpose: '' }], { assets } as any, words, 25), /смысл/);
});

test('semantic cuts align hyphenated words without moving or shortening the quote', () => {
  const words = ['ДВОЕ', '15-ЛЕТНИХ', 'ПОДРОСТКОВ', 'ЗАКАЗАЛИ', 'ТАКСИ'].map((word, i) => ({ word, start: i, end: i + 0.5 }));
  assert.deepEqual(locateQuote(words, 'ДВОЕ 15-ЛЕТНИХ ПОДРОСТКОВ ЗАКАЗАЛИ'), { from: 0, to: 3 });
  assert.equal(locateQuote(words, 'ДВОЕ 15-ЛЕТНИХ ПОДРОСТКОВ ПОЗВОНИЛИ'), null);
});
