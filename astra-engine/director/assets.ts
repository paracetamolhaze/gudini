import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as simpleIcons from "simple-icons";
import sharp from "sharp";
import emojiData from "unicode-emoji-json/data-by-emoji.json";
import { postBridge } from "./bridge";

/** One look for every generated picture of a video: a real vertical photo, the subject whole and centered. */
export const SCENE_STYLE = "Photorealistic vertical photo, as if shot on a good phone camera for a news story: natural light, real materials and people, " +
  "realistic proportions, sharp focus on the subject. The picture will be cropped to a narrow vertical 9:16 phone screen, so the outer sides are cut away: " +
  "keep the main subject and every important person and object within the central 65% of the width, large, whole and close together; " +
  "only background goes into the outer side strips. Nothing important touches any edge. " +
  "No text, no captions, no watermark, no logos except those that are part of real objects. Scene: ";

/**
 * Turns what a montage asks for into files in the bundle's public folder:
 * emoji become Microsoft Fluent 3D pictures (MIT), logos come from Simple Icons (CC0)
 * or the company's Wikipedia page, photos from Pexels / Pixabay (free licenses).
 */
export type AssetNeeds = {
  emoji: string[]; logos: string[]; photos: string[]; looks?: Record<string, string>;
  scenes?: string[]; memes?: string[]; morphs?: { from: number; into: string }[];
};
export type ResolvedAssets = { assets: Record<string, string>; sizes: Record<string, { w: number; h: number }>; missing: string[] };

const FLUENT = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets";
const UA = { "User-Agent": "Gudini-Astra/1.0 (video montage; contact: owner)" };

async function download(url: string, file: string, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { ...UA, ...headers } });
    if (!res.ok) return false;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 200) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return true;
  } catch { return false; }
}

const slugify = (text: string) => text.toLowerCase().replace(/ё/g, "е").replace(/[^a-z0-9а-я]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);

async function fluentEmoji(glyph: string, dir: string): Promise<string | null> {
  const data = emojiData as Record<string, { name: string; slug: string }>;
  const entry = data[glyph] ?? data[glyph.replace(/️/g, "")] ?? data[`${glyph}️`];
  if (!entry) return null;
  const file = path.join(dir, `${entry.slug}.png`);
  if (fs.existsSync(file)) return file;
  const folder = entry.name.charAt(0).toUpperCase() + entry.name.slice(1);
  const base = `${FLUENT}/${encodeURIComponent(folder)}`;
  for (const url of [`${base}/3D/${entry.slug}_3d.png`, `${base}/Default/3D/${entry.slug}_3d_default.png`]) {
    if (await download(url, file)) return file;
  }
  return null;
}

function simpleIconSvg(name: string): string | null {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const icon = Object.values(simpleIcons).find((i: any) => i && typeof i === "object" && "slug" in i && (i.slug === key || i.title.toLowerCase().replace(/[^a-z0-9]/g, "") === key)) as
    { path: string; hex: string } | undefined;
  if (!icon) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${icon.hex}" d="${icon.path}"/></svg>`;
}

async function wikipediaLogo(name: string, file: string): Promise<boolean> {
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s+/g, "_"))}`, { headers: UA });
    if (!res.ok) return false;
    const page = await res.json() as { originalimage?: { source: string }; thumbnail?: { source: string } };
    const source = page.originalimage?.source ?? page.thumbnail?.source;
    return source ? download(source, file) : false;
  } catch { return false; }
}

async function logo(name: string, dir: string): Promise<string | null> {
  const svg = simpleIconSvg(name);
  if (svg) {
    const file = path.join(dir, `${slugify(name)}.svg`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, svg);
    return file;
  }
  for (const ext of ["svg", "png"]) {
    const cached = path.join(dir, `${slugify(name)}.${ext}`);
    if (fs.existsSync(cached)) return cached;
  }
  const file = path.join(dir, `${slugify(name)}.png`);
  return (await wikipediaLogo(name, file)) ? file : null;
}

type Candidate = { preview: string; full: string };

/** A photo is chosen for a query *and* what must be visible on it, so a new `look` picks again. */
function photoFile(dir: string, query: string, look?: string): string {
  const tag = look ? createHash("sha1").update(look).digest("hex").slice(0, 8) : "any";
  return path.join(dir, `${slugify(query)}-${tag}.jpg`);
}

/** Up to six vertical stock photos per query from Pexels, then Pixabay: vertical pictures fill a vertical video. */
async function photoCandidates(query: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const pexels = process.env.PEXELS_API_KEY;
  if (pexels) {
    try {
      const res = await fetch(`https://api.pexels.com/v1/search?per_page=6&orientation=portrait&query=${encodeURIComponent(query)}`, { headers: { Authorization: pexels } });
      const data = await res.json() as { photos?: { src: { medium: string; large2x: string } }[] };
      for (const p of data.photos ?? []) found.push({ preview: p.src.medium, full: p.src.large2x });
    } catch { /* Pixabay next */ }
  }
  const pixabay = process.env.PIXABAY_API_KEY;
  if (pixabay && found.length < 6) {
    try {
      const res = await fetch(`https://pixabay.com/api/?key=${pixabay}&image_type=photo&orientation=vertical&per_page=6&safesearch=true&q=${encodeURIComponent(query)}`);
      const data = await res.json() as { hits?: { webformatURL: string; largeImageURL: string }[] };
      for (const h of data.hits ?? []) found.push({ preview: h.webformatURL, full: h.largeImageURL });
    } catch { /* nothing more */ }
  }
  return found.slice(0, 6);
}

/**
 * Photos are chosen by eye: Astra sees the candidates for every query and picks the one that
 * shows the thing clearly, or none. Without a picker the first result is taken.
 */
async function photos(queries: string[], dir: string, pick?: PhotoPicker, looks: Record<string, string> = {}): Promise<{ files: Record<string, string | null>; rejected: Set<string> }> {
  const result: Record<string, string | null> = {};
  const rejected = new Set<string>();
  const pending: { query: string; candidates: Candidate[]; previews: Buffer[] }[] = [];
  for (const query of queries) {
    const file = photoFile(dir, query, looks[query]);
    if (fs.existsSync(file)) { result[query] = file; continue; }
    const candidates = await photoCandidates(query);
    const previews: Buffer[] = [];
    for (const c of candidates) {
      try { const r = await fetch(c.preview, { headers: UA }); previews.push(Buffer.from(await r.arrayBuffer())); } catch { previews.push(Buffer.alloc(0)); }
    }
    pending.push({ query, candidates, previews });
  }
  const choices = pick && pending.some(p => p.candidates.length) ? await pick(pending.map(p => ({ query: p.query, look: looks[p.query], previews: p.previews }))) : {};
  for (const p of pending) {
    const index = pick ? choices[p.query] ?? -1 : 0;
    const chosen = index >= 0 ? p.candidates[index] : undefined;
    if (!chosen && p.candidates.length) rejected.add(p.query);
    const file = photoFile(dir, p.query, looks[p.query]);
    result[p.query] = chosen && await download(chosen.full, file) ? file : null;
  }
  return { files: result, rejected };
}

/** Given previews per query (and what must be visible), returns the chosen index per query (-1 = none fits). */
export type PhotoPicker = (sets: { query: string; look?: string; previews: Buffer[] }[]) => Promise<Record<string, number>>;

/** Last generation errors, so a failure can be explained to Astra instead of "did not work". */
export const generationErrors: string[] = [];

async function generate(prompt: string, file: string, references: string[] = [], mode: "generate" | "edit" = "generate"): Promise<string | null> {
  if (fs.existsSync(file)) return file;
  // The image tool sometimes ends a run without a picture; a second try usually succeeds.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await postBridge<{ base64: string }>("/image", { prompt, aspectRatio: "4:5", references, mode },
        20 * 60_000, process.env.CODEX_IMAGE_BRIDGE_URL ?? process.env.CODEX_BRIDGE_URL);
      if (!result?.base64) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(result.base64, "base64"));
      return file;
    } catch (error) {
      generationErrors.push(String((error as Error).message).slice(0, 300));
    }
  }
  return null;
}

const sceneTag = (prompt: string) => createHash("sha1").update(SCENE_STYLE + prompt).digest("hex").slice(0, 8);

/**
 * A scene that was redrawn or rewritten stays attached to the prompt the montage uses,
 * so the next build takes the approved picture instead of generating the first attempt again.
 */
function aliases(dir: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "aliases.json"), "utf8")); } catch { return {}; }
}
function remember(dir: string, prompt: string, file: string) {
  const all = aliases(dir);
  all[sceneTag(prompt)] = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "aliases.json"), JSON.stringify(all, null, 2));
}

const scene = (prompt: string, dir: string) => {
  const approved = aliases(dir)[sceneTag(prompt)];
  if (approved && fs.existsSync(path.join(dir, approved))) return Promise.resolve(path.join(dir, approved));
  return generate(SCENE_STYLE + prompt, path.join(dir, `${slugify(prompt)}-${sceneTag(prompt)}.png`));
};

/** A generated picture again, with what was wrong in the previous attempt spelled out. */
export async function redrawScene(prompt: string, fix: string, publicDir: string, cacheSubdir: string): Promise<{ file: string; size?: { w: number; h: number } } | null> {
  const full = `${prompt}\nThe previous attempt was wrong: ${fix}. Make sure this time the picture shows exactly the scene described.`;
  const dir = path.join(publicDir, cacheSubdir, "scenes");
  const file = await generate(SCENE_STYLE + full, path.join(dir, `${slugify(prompt)}-${sceneTag(full)}.png`));
  if (!file) return null;
  remember(dir, prompt, file);
  const m = await sharp(file).metadata().catch(() => null);
  return { file: path.relative(publicDir, file).split(path.sep).join("/"), size: m?.width && m.height ? { w: m.width, h: m.height } : undefined };
}

/**
 * The author turned into something for a moment: the frame at `from` is edited around the author
 * (a 4:5 region, pose and room kept) and pasted back into the full frame with soft edges.
 */
async function morph(video: string, from: number, into: string, face: { y: number }, dir: string): Promise<string | null> {
  const tag = createHash("sha1").update(`${video}|${from.toFixed(2)}|${into}`).digest("hex").slice(0, 10);
  const out = path.join(dir, `morph-${tag}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `morph-${tag}-base.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", from.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=1080:1920", base]);
  const y0 = Math.max(0, Math.min(1920 - 1350, Math.round(face.y - 150)));
  const region = await sharp(base).extract({ left: 0, top: y0, width: 1080, height: 1350 }).jpeg({ quality: 95 }).toBuffer();
  const edited = await generate(
    `Edit this photo: transform the person into ${into}. Keep the same head position, framing, camera angle, the microphone in front, ` +
      "the chair, the room and the lighting; change the pose only where the description needs it (for example a hand raised to hold a phone to the ear). " +
      "Photorealistic, same composition and image size. No text.",
    path.join(dir, `morph-${tag}-edit.png`), [`data:image/jpeg;base64,${region.toString("base64")}`], "edit");
  if (!edited) return null;
  // Soft top and bottom edges so the edited region melts into the untouched frame.
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.07" stop-color="#fff" stop-opacity="1"/>
    <stop offset="0.93" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <rect width="1080" height="1350" fill="url(#g)"/></svg>`);
  const patch = await sharp(edited).resize(1080, 1350, { fit: "fill" }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  await sharp(base).composite([{ input: patch, top: y0, left: 0 }]).jpeg({ quality: 92 }).toFile(out);
  return out;
}

/** Meme clips the owner put into the library (assets/astra/memes), by file name without extension. */
export function listMemes(memesDir: string | undefined): Record<string, string> {
  if (!memesDir || !fs.existsSync(memesDir)) return {};
  return Object.fromEntries(fs.readdirSync(memesDir).filter(f => /\.(mp4|webm|mov)$/i.test(f)).map(f => [f.replace(/\.[^.]+$/, ""), path.join(memesDir, f)]));
}

/** Resolves every need into `assets` keys the kit reads: emoji:, logo:, photo:, scene:, meme:, morph:. */
export async function resolveAssets(needs: AssetNeeds, publicDir: string, cacheSubdir: string, options: {
  pick?: PhotoPicker; memesDir?: string; drawMissingPhotos?: boolean; video?: string; face?: { y: number };
  /** Rewrites a scene the generator refused, keeping who, what and where; the result replaces it under the same key. */
  rescue?: (prompt: string, error: string) => Promise<string | null>;
} = {}): Promise<ResolvedAssets> {
  const assets: Record<string, string> = {};
  const sizes: Record<string, { w: number; h: number }> = {};
  const missing: string[] = [];
  const rel = (file: string) => path.relative(publicDir, file).split(path.sep).join("/");
  const cache = path.join(publicDir, cacheSubdir);
  const put = async (key: string, file: string) => {
    assets[key] = rel(file);
    try { const m = await sharp(file).metadata(); if (m.width && m.height) sizes[key] = { w: m.width, h: m.height }; } catch { /* svg or broken: shown by its box */ }
  };
  for (const glyph of needs.emoji) {
    const file = await fluentEmoji(glyph, path.join(cache, "emoji"));
    if (file) await put(`emoji:${glyph}`, file);
  }
  for (const name of needs.logos) {
    const file = await logo(name, path.join(cache, "logos"));
    if (file) await put(`logo:${name.toLowerCase()}`, file);
    else missing.push(`Логотип «${name}» не нашёлся — покажи название словом за спиной автора (BehindText) или сценой.`);
  }
  // Stock photos are searched only when asked (ASTRA_STOCK_PHOTOS=1); otherwise the picture is generated from `look`.
  const found = process.env.ASTRA_STOCK_PHOTOS === "1"
    ? await photos(needs.photos, path.join(cache, "photos"), options.pick, needs.looks)
    : { files: {} as Record<string, string | null>, rejected: new Set<string>() };
  for (const query of needs.photos) {
    let file = found.files[query];
    // No stock photo shows it: a realistic picture is generated from what must be visible.
    if (!file && options.drawMissingPhotos) file = await scene(needs.looks?.[query] ?? query, path.join(cache, "scenes"));
    if (file) await put(`photo:${query}`, file);
    else if (found.rejected.has(query)) missing.push(`Фото по запросу «${query}» нашлись, но ни одно не показывает «${needs.looks?.[query] ?? query}». Попробуй другие слова запроса или покажи это сценой (Scene).`);
    else missing.push(`Фото по запросу «${query}» не нашлось: на фотостоках ищут 2–4 словами («water beads», «police dog»). Дай другой запрос или покажи сценой (Scene).`);
  }
  for (const prompt of needs.scenes ?? []) {
    let file = await scene(prompt, path.join(cache, "scenes"));
    // On the last round a refused scene gets a second life: Astra rewrites it so it can be generated.
    if (!file && options.drawMissingPhotos && options.rescue) {
      const rewritten = await options.rescue(prompt, generationErrors.at(-1) ?? "the generator returned no picture");
      if (rewritten) file = await scene(rewritten, path.join(cache, "scenes"));
      if (file) remember(path.join(cache, "scenes"), prompt, file);
    }
    if (file) await put(`scene:${prompt}`, file);
    else missing.push(`Сцену «${prompt.slice(0, 80)}…» сгенерировать не удалось (${generationErrors.at(-1) ?? "генератор не вернул картинку"}) — опиши её иначе: например, покажи действие со стороны, без крупных лиц, или покажи иначе.`);
  }
  for (const m of needs.morphs ?? []) {
    if (!options.video) break;
    const file = await morph(options.video, m.from, m.into, options.face ?? { y: 445 }, path.join(cache, "morphs"));
    if (file) await put(`morph:${m.from.toFixed(2)}`, file);
    else missing.push(`Превращение на ${m.from.toFixed(2)} с не получилось — выбери другой момент или опиши превращение проще.`);
  }
  const library = listMemes(options.memesDir);
  for (const name of needs.memes ?? []) {
    const source = library[name];
    if (!source) { missing.push(`Мема «${name}» нет в библиотеке — выбери из списка в задании или покажи иначе.`); continue; }
    const target = path.join(cache, "memes", path.basename(source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    assets[`meme:${name}`] = rel(target);
  }
  return { assets, sizes, missing };
}
