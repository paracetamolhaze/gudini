import test from 'node:test';
import assert from 'node:assert/strict';
import { beatQueries, verifyNeedImageSource } from '../lib/storyAssetPack';
import './montageContinuous.test';

test("general object research does not require the story brand or incident year", () => {
  const research: any = { kind: "NEWS_EVENT", topic: "robotaxi", eventYear: 2026, entities: [{ id: "w", name: "Waymo", aliases: [] }] };
  const need: any = { intent: "GENERAL", entities: [], visualDescription: "A close-up product photograph of a toy gel blaster with gel beads." };
  assert.ok(beatQueries(research, need).every(q => !/Waymo|2026/.test(q)));
  const subject = { title: "Toy gel blaster product", sourceUrl: "https://example.com/toy" };
  assert.equal(verifyNeedImageSource(subject, research, need).ok, true);
  assert.equal(verifyNeedImageSource({ title: "Waymo car on a street", sourceUrl: "https://example.com/car" }, research, need).ok, false);
  assert.equal(verifyNeedImageSource(subject, research, { ...need, intent: "EXACT_EVENT" }).ok, false);
});
