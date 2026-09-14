import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, probe } from "./ffmpeg";
import { mediaVision, parseJson } from "./mediaLlm";
import { authorFitFilter, cardAboveHead, CardRect } from "./topInset";

/** Sample the whole clean recording; reserve extra room for movement between samples.
 * This measures composition, not identity. Never silently use an unmeasured layout.
 */
export async function measureAuthorCard(dir: string, source: string, duration: number): Promise<CardRect> {
  const file = path.isAbsolute(source) ? source : path.join(dir, source);
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}:${duration}:1`;
  const cache = path.join(dir, "author-headroom.json");
  try {
    const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (saved.key === key) return cardAboveHead(Math.min(...saved.headTops));
  } catch { /* missing or obsolete measurement */ }
  const info = await probe(file);
  const count = Math.min(24, Math.max(4, Math.ceil(duration / 4)));
  const samples: string[] = [];
  const times: number[] = [];
  const tmp = path.join(dir, "author-headroom");
  fs.mkdirSync(tmp, { recursive: true });
  for (let i = 0; i < count; i++) {
    const at = Math.max(0, duration - 0.15) * i / (count - 1);
    const out = path.join(tmp, `frame-${i}.jpg`);
    await runFfmpeg(["-ss", at.toFixed(3), "-i", file, "-frames:v", "1", "-vf",
      `${authorFitFilter(info.displayWidth, info.displayHeight)},scale=360:640`, "-q:v", "3", out]);
    samples.push(out); times.push(at);
  }
  const raw = await mediaVision({
    stage: "Creative Director", maxTokens: 1800,
    system: "Measure the TOP OF THE PRESENTER'S WHOLE HEAD including hair/crown in every image. Do not identify the person. Images are 360x640. Return strict JSON {\"headTops\":[y,...]} in image order, y in pixels 0..640. Use the highest visible point of hair/head, NOT forehead, eyes or face bounding box. Ignore people on background monitors. If uncertain or the presenter is absent use null. Do not guess missing detections.",
    user: `${count} frames of one recording at seconds ${times.map(t => t.toFixed(1)).join(", ")}. Locate the crown separately in EVERY frame.`,
    images: samples.map(f => ({ base64: fs.readFileSync(f).toString("base64"), mediaType: "image/jpeg" as const })),
  });
  const values = parseJson<{ headTops: unknown[] }>(raw, "Положение головы автора").headTops;
  if (!Array.isArray(values) || values.length !== count || values.some(y => typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 640)) {
    throw new Error("Не удалось уверенно определить голову автора во всех контрольных кадрах");
  }
  const headTops = (values as number[]).map(y => y * 3);
  const card = cardAboveHead(Math.min(...headTops));
  fs.writeFileSync(cache, JSON.stringify({ key, times, headTops, card, clearance: 72 }, null, 2));
  return card;
}
