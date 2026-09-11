import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";
import { generateGroups, generateShot } from "../lib/aiFilm/generate";
import { shotKey } from "../lib/aiFilm/plan";
import { resetLedger, setRunCostLimit } from "../lib/costLedger";
import { audioFilter, compositeFilter, overlaysFor } from "../lib/aiFilm/composite";
import { checkAiSegments } from "../lib/aiFilm/check";
import { ffmpegBin, probe, runFfmpeg } from "../lib/ffmpeg";
import type { AiFilmPlan, CharacterProfile, FilmShot } from "../lib/aiFilm/types";

const shot: FilmShot = {
  id: "G1-1", groupId: "G1", index: 0, beatIds: ["B1"], displayMode: "full_ai",
  gudiniVisible: false, generationProfile: "environment", model: "veo-3.1-fast-generate-001",
  mode: "text", usedSeconds: 8, veoSeconds: 8, aspectRatio: "9:16", resolution: "720p",
  useReferences: false, eventIds: [], changeBySec: null, deadlines: [], prompt: "An empty forest", dependsOn: null, cost: 0.64,
};

test("Veo: a failed download resumes the accepted operation without paying for a second generation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-veo-retry-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); });
  resetLedger();
  t.mock.method(GoogleAuth.prototype, "getClient", async () => ({ getAccessToken: async () => ({ token: "test-token" }) }) as any);
  let starts = 0;
  let download: Buffer | null = null;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const address = String(url);
    if (address.endsWith(":predictLongRunning")) {
      starts++;
      return Response.json({ name: `operations/test-${starts}` });
    }
    if (address.endsWith(":fetchPredictOperation")) return Response.json({ done: true, response: { videos: [{ gcsUri: "gs://test/result.mp4" }] } });
    if (address.startsWith("https://storage.googleapis.com/")) return download
      ? new Response(new Uint8Array(download)) : new Response("download unavailable", { status: 503 });
    throw new Error(`Unexpected network request: ${address}`);
  });
  const args = { dir, projectId: "audit", plan: { bible: { supportingCharacters: [] } } as any, shot, key: shotKey(shot, "test-refs", null), references: [] };
  await assert.rejects(generateShot(args), /download unavailable/);
  await assert.rejects(generateShot(args), /download unavailable/);
  assert.equal(starts, 1, "retry must reuse the paid operation after a transport/download error");
  download = execFileSync(ffmpegBin(), [
    "-hide_banner", "-f", "lavfi", "-i", "testsrc2=size=320x180:duration=2", "-c:v", "libx264", "-preset", "ultrafast",
    "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  resetLedger();
  const recovered = await generateGroups({
    dir, projectId: "audit", concurrency: 1,
    plan: { shots: [shot], groups: [{ id: "G1", shotIds: [shot.id] }] } as AiFilmPlan,
    character: { refHash: "test-refs", referenceFiles: [] } as unknown as CharacterProfile,
  });
  assert.equal(starts, 1);
  assert.equal(recovered.spent, 0, "successful recovery must report only spending in this run");
});

test("AI film composite: full-screen and hybrid windows render and pass QC from a small source, with and without music", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-film-smoke-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await runFfmpeg([
    "-f", "lavfi", "-i", "color=c=0x454568:size=360x640:rate=30:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "author.mp4",
  ], { cwd: dir });
  await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "clip.mp4"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "subs.ass"), "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
  const plan = {
    timeline: [{ start: 0, end: 4, mode: "full_ai", groupId: "G1", beatIds: ["B1"] }, { start: 4, end: 8, mode: "hybrid", groupId: "G2", beatIds: ["B2"] }],
    groups: [{ id: "G1", start: 0, end: 4 }, { id: "G2", start: 4, end: 8 }],
  } as AiFilmPlan;
  const clips = ["G1", "G2"].map((groupId) => ({ groupId, file: "clip.mp4", seconds: 8 }));
  for (const music of [false, true]) {
    await t.test(music ? "with music" : "without music", async () => {
      await runFfmpeg([
        "-i", "author.mp4", ...(music ? ["-f", "lavfi", "-i", "sine=frequency=100:sample_rate=48000:duration=8"] : []),
        "-i", "clip.mp4", "-i", "clip.mp4",
        "-filter_complex", `${compositeFilter("scale=1080:1920,setsar=1", overlaysFor(plan, clips), plan, music ? 2 : 1)};${audioFilter(music)}`,
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-c:a", "aac", "out.mp4",
      ], { cwd: dir });
      const output = await probe(path.join(dir, "out.mp4"));
      assert.equal(output.width, 1080);
      assert.equal(output.height, 1920);
      assert.ok(output.hasAudio);
      assert.ok(Math.abs(output.duration - 8) < 0.15);
      await checkAiSegments(dir, plan, "author.mp4");
    });
  }
});

test("music ducking preserves the normalized voice level", () => {
  const rms = (music: boolean) => {
    const pcm = execFileSync(ffmpegBin(), [
      "-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3,volume=0.01",
      ...(music ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=3"] : []),
      "-filter_complex", audioFilter(music), "-map", "[a]", "-f", "f32le", "-",
    ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    let sum = 0;
    for (let i = 0; i + 4 <= pcm.length; i += 4) sum += pcm.readFloatLE(i) ** 2;
    return Math.sqrt(sum / (pcm.length / 4));
  };
  const deltaDb = 20 * Math.log10(rms(true) / rms(false));
  assert.ok(Math.abs(deltaDb) < 0.5, `silent music changed voice loudness by ${deltaDb.toFixed(2)} dB`);
});

test("повторный запуск после отказа операции снова проходит бюджетный контроль", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-veo-budget-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLedger(); setRunCostLimit(null); });
  resetLedger();
  // Предел ровно на один клип: вторая принятая операция обязана упереться в бюджет.
  setRunCostLimit(0.64);
  t.mock.method(GoogleAuth.prototype, "getClient", async () => ({ getAccessToken: async () => ({ token: "test-token" }) }) as any);
  let starts = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const address = String(url);
    if (address.endsWith(":predictLongRunning")) return Response.json({ name: `operations/budget-${++starts}` });
    // первая операция отклонена по правам третьих лиц — сцена уходит на повтор без имён
    if (address.endsWith(":fetchPredictOperation")) {
      return starts === 1
        ? Response.json({ done: true, error: { message: "the interests of third-party content providers" } })
        : Response.json({ done: true, response: { videos: [{ gcsUri: "gs://test/result.mp4" }] } });
    }
    if (address.startsWith("https://storage.googleapis.com/")) return new Response("download unavailable", { status: 503 });
    throw new Error(`Unexpected network request: ${address}`);
  });
  const named: FilmShot = { ...shot, prompt: "Tony Stark walks out of the hangar", cost: 0.64 };
  const plan = { bible: { supportingCharacters: [], reconstruction: false }, character: { name: "Gudini" } } as any;
  await assert.rejects(
    generateShot({ dir, projectId: "budget", plan, shot: named, key: shotKey(named, "refs", null), references: [] }),
    /предел|budget|лимит/i,
    "второй запуск обязан упереться в бюджет, а не уйти в Veo",
  );
  assert.equal(starts, 1, "принятых операций должно быть ровно одна");
});

test("замершее окно отвергается и на коротком показе, и на длинном", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gudini-frozen-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const still = (seconds: number, file: string) =>
    execFileSync(ffmpegBin(), [
      "-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=gray:size=270x480:duration=${seconds}:rate=25`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, file),
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const moving = (seconds: number, file: string) =>
    execFileSync(ffmpegBin(), [
      "-hide_banner", "-y", "-f", "lavfi", "-i", `testsrc2=size=270x480:duration=${seconds}:rate=25`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, file),
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  for (const len of [3, 8]) {
    still(len, "out.mp4");
    moving(len, "src.mp4");
    const plan = { timeline: [{ start: 0, end: len, mode: "full_ai", beatIds: ["B1"] }] } as any;
    await assert.rejects(
      checkAiSegments(dir, plan, "src.mp4", "out.mp4"),
      /застыло/,
      `полностью неподвижное окно ${len} с обязано отклоняться`,
    );
  }
});
