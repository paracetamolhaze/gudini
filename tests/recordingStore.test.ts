import test from "node:test";
import assert from "node:assert/strict";
import { saveRecording, loadRecording, deleteRecording } from "../lib/recordingStore";

test("без IndexedDB (сервер, старый браузер) хранилище записи не падает", async () => {
  assert.equal(typeof (globalThis as any).indexedDB, "undefined");
  assert.equal(await saveRecording("p1", new Blob(["x"]), "record.mp4"), false);
  assert.equal(await loadRecording("p1"), null);
  await deleteRecording("p1");
});
