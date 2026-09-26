import fs from "node:fs";
import path from "node:path";
import * as simpleIcons from "simple-icons";
import emojiData from "unicode-emoji-json/data-by-emoji.json";

/**
 * Turns what a montage asks for into files in the bundle's public folder:
 * emoji become Microsoft Fluent 3D pictures (MIT), logos come from Simple Icons (CC0)
 * or the company's Wikipedia page, photos from Pexels / Pixabay (free licenses).
 */
export type AssetNeeds = { emoji: string[]; logos: string[]; photos: string[] };
export type ResolvedAssets = { assets: Record<string, string>; missing: string[] };

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

/** Up to four stock photos per query from Pexels, then Pixabay. */
async function photoCandidates(query: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const pexels = process.env.PEXELS_API_KEY;
  if (pexels) {
    try {
      const res = await fetch(`https://api.pexels.com/v1/search?per_page=4&query=${encodeURIComponent(query)}`, { headers: { Authorization: pexels } });
      const data = await res.json() as { photos?: { src: { medium: string; large2x: string } }[] };
      for (const p of data.photos ?? []) found.push({ preview: p.src.medium, full: p.src.large2x });
    } catch { /* Pixabay next */ }
  }
  const pixabay = process.env.PIXABAY_API_KEY;
  if (pixabay && found.length < 4) {
    try {
      const res = await fetch(`https://pixabay.com/api/?key=${pixabay}&image_type=photo&per_page=4&safesearch=true&q=${encodeURIComponent(query)}`);
      const data = await res.json() as { hits?: { webformatURL: string; largeImageURL: string }[] };
      for (const h of data.hits ?? []) found.push({ preview: h.webformatURL, full: h.largeImageURL });
    } catch { /* nothing more */ }
  }
  return found.slice(0, 4);
}

/**
 * Photos are chosen by eye: Astra sees the candidates for every query and picks the one that
 * shows the thing clearly, or none. Without a picker the first result is taken.
 */
async function photos(queries: string[], dir: string, pick?: PhotoPicker): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const pending: { query: string; candidates: Candidate[]; previews: Buffer[] }[] = [];
  for (const query of queries) {
    const file = path.join(dir, `${slugify(query)}.jpg`);
    if (fs.existsSync(file)) { result[query] = file; continue; }
    const candidates = await photoCandidates(query);
    const previews: Buffer[] = [];
    for (const c of candidates) {
      try { const r = await fetch(c.preview, { headers: UA }); previews.push(Buffer.from(await r.arrayBuffer())); } catch { previews.push(Buffer.alloc(0)); }
    }
    pending.push({ query, candidates, previews });
  }
  const choices = pick && pending.some(p => p.candidates.length) ? await pick(pending.map(p => ({ query: p.query, previews: p.previews }))) : {};
  for (const p of pending) {
    const index = pick ? choices[p.query] ?? -1 : 0;
    const chosen = index >= 0 ? p.candidates[index] : undefined;
    const file = path.join(dir, `${slugify(p.query)}.jpg`);
    result[p.query] = chosen && await download(chosen.full, file) ? file : null;
  }
  return result;
}

/** Given previews per query, returns the chosen index per query (-1 = none fits). */
export type PhotoPicker = (sets: { query: string; previews: Buffer[] }[]) => Promise<Record<string, number>>;

/** Resolves every need into `assets` keys the kit reads: emoji:<glyph>, logo:<name>, photo:<query>. */
export async function resolveAssets(needs: AssetNeeds, publicDir: string, cacheSubdir: string, pick?: PhotoPicker): Promise<ResolvedAssets> {
  const assets: Record<string, string> = {};
  const missing: string[] = [];
  const rel = (file: string) => path.relative(publicDir, file).replace(/\\/g, "/");
  const cache = path.join(publicDir, cacheSubdir);
  for (const glyph of needs.emoji) {
    const file = await fluentEmoji(glyph, path.join(cache, "emoji"));
    if (file) assets[`emoji:${glyph}`] = rel(file);
  }
  for (const name of needs.logos) {
    const file = await logo(name, path.join(cache, "logos"));
    if (file) assets[`logo:${name.toLowerCase()}`] = rel(file);
    else missing.push(`Логотип «${name}» не нашёлся ни в библиотеке, ни в Википедии — покажи это иначе (фото, эмодзи, карта).`);
  }
  const found = await photos(needs.photos, path.join(cache, "photos"), pick);
  for (const query of needs.photos) {
    const file = found[query];
    if (file) assets[`photo:${query}`] = rel(file);
    else missing.push(`Фото по запросу «${query}» не нашлось: на фотостоках ищут 2–4 словами («water beads», «toy gun»). Дай запрос короче или покажи иначе; fallback с эмодзи подстрахует.`);
  }
  return { assets, missing };
}
