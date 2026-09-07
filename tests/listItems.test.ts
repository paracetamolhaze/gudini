import test from "node:test";
import assert from "node:assert/strict";
import { refineMontage } from "../lib/montageRefine";
import type { Word } from "../lib/transcribe";

// Вступление 8 с, потом перечисление актёров: три коротких блока по ~1.3 с
const intro = "Третье. Каст этого фильма собрал вообще всех звёзд планеты";
const items = ["Томас Холланд", "Аннабель Хэтэуэй", "Роберт Паттинсон"];
const words: Word[] = [];
let t = 0.5;
for (const w of intro.split(/\s+/)) { words.push({ word: w, start: t, end: t + 0.4 }); t += 0.7; }
t += 1;
const itemStarts: number[] = [];
for (const item of items) {
  itemStarts.push(t);
  for (const w of item.split(/\s+/)) { words.push({ word: w, start: t, end: t + 0.4 }); t += 0.65; }
}
const duration = t + 2;

function run(listItem: boolean) {
  const beats: any[] = [
    { id: "b0", text: intro, visualNeed: "CONTEXT" },
    ...items.map((text, i) => ({ id: `b${i + 1}`, text, visualNeed: "ENTITY", listItem })),
  ];
  const needs: any[] = beats.map((b) => ({ beatId: b.id, intent: b.visualNeed, entities: [], visualDescription: b.text }));
  const asset = (id: string, beatId: string): any => ({
    id, kind: "IMAGE", file: `img-${id}.jpg`, sourceUrl: "https://x/" + id, sourceDomain: "x", description: id,
    role: "PERSON", compatibleBeatIds: [beatId], beatScores: { [beatId]: 3 }, relatedFactIds: [],
    verification: { sourceVerified: true, visualVerified: true, version: 5 },
  });
  const pack: any = { assets: [asset("cast", "b0"), asset("holland", "b1"), asset("hathaway", "b2"), asset("pattinson", "b3")], coverage: [] };
  const montage: any = { events: [], stats: {} };
  return refineMontage({ montage, pack, beats, needs, words, duration });
}

test("элементы перечисления держат по короткой карточке, а не сливаются в одну", () => {
  const r = run(true);
  const listSlots = r.slots.filter((s) => s.beatId !== "b0");
  assert.equal(listSlots.length, 3, r.notes.join("; "));
  for (const s of listSlots) assert.ok(s.end - s.start >= 1.0 - 0.01, `${s.beatId}: ${(s.end - s.start).toFixed(2)}`);
});

test("без пометки списка короткие блоки сливаются, как раньше", () => {
  const r = run(false);
  const listSlots = r.slots.filter((s) => s.beatId !== "b0");
  assert.ok(listSlots.length < 3, `slots=${listSlots.length}`);
});
