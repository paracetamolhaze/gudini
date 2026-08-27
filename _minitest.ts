// Мини-тест гибрида: тигр + деньги, FULL_AI vs RENDERER_TEXT (обе картинки — Flash).
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { CoverConcept } from "./lib/cover";
import { buildFullCoverPrompt, buildCoverImagePromptFull } from "./lib/coverPrompt";
import { selectTypographyMode } from "./lib/coverTypography";
import { computeLayout, buildCoverHeadlineAss, resolveCoverFontFile, loadDisplayFont } from "./lib/coverLayout";
import type { HeadlineLine } from "./lib/coverLayout";
const run = promisify(execFile);

const env = fs.readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const KEY = process.env.OPENROUTER!;
const MODEL = "google/gemini-3.1-flash-image";
const OUT = path.join(process.cwd(), "data", "cover-minitest");

function concept(base: CoverConcept, lines: HeadlineLine[], kicker: string): CoverConcept {
  return {
    ...base,
    headline: lines.map((l) => l.text).join("\n"),
    headlineLines: lines,
    kicker,
    typographyDirection: "ACCENT_BOX", // эталон genetics-ряда: одна жёлтая плашка
  };
}

async function genImage(prompt: string, faceB64: string, file: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${faceB64}` } },
          ]}],
          modalities: ["image", "text"],
          usage: { include: true },
        }),
      });
      const json: any = await res.json();
      if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 120)}`);
      const img = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!img?.startsWith("data:")) throw new Error("нет изображения");
      fs.writeFileSync(file, Buffer.from(img.slice(img.indexOf(",") + 1), "base64"));
      return json.usage?.cost ?? null;
    } catch (e: any) {
      console.warn(`${path.basename(file)}: попытка ${attempt} — ${String(e.message).slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw new Error(`не удалось сгенерировать ${file}`);
}

// Производственная цепочка рендерера: raw → lossless finishing → ASS-заголовок → jpg
async function renderText(raw: string, c: CoverConcept, dir: string): Promise<string> {
  await run("ffmpeg", ["-y", "-i", raw, "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920," +
    "unsharp=5:5:0.55:5:5:0.0,eq=contrast=1.03:saturation=1.02", "-frames:v", "1",
    path.join(dir, "base.png")]);
  const layout = computeLayout(c.headlineLines);
  fs.writeFileSync(path.join(dir, "text.ass"), buildCoverHeadlineAss(layout, c.kicker), "utf8");
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  const font = resolveCoverFontFile();
  fs.copyFileSync(font.file, path.join(dir, "fonts", path.basename(font.file)));
  const final = path.join(dir, "final.jpg");
  await run("ffmpeg", ["-y", "-i", "base.png", "-vf", "ass=text.ass:fontsdir=fonts", "-frames:v", "1", "-q:v", "1", "final.jpg"], { cwd: dir } as any);
  return final;
}

async function main() {
  const face = fs.readFileSync(path.join(process.cwd(), "data", "face.jpg")).toString("base64");
  const tigerBase: CoverConcept = JSON.parse(fs.readFileSync("data/cover-fullbench/tiger/concept.json", "utf8"));
  const moneyBase: CoverConcept = JSON.parse(fs.readFileSync("data/cover-fullbench/money/concept.json", "utf8"));

  // проверка: есть ли «→» в нашем шрифте для renderer-заголовка «5000$ → 300$»
  const { font } = loadDisplayFont();
  const hasArrow = font.charToGlyphIndex("→") > 0;
  console.log(`шрифт: стрелка → ${hasArrow ? "есть" : "НЕТ — беру вариант без стрелки"}`);
  const moneyRendererLines: HeadlineLine[] = hasArrow
    ? [{ text: "5000$ → 300$", accent: false }, { text: "ЗА МЕСЯЦ", accent: "box" }]
    : [{ text: "5000$", accent: false }, { text: "СТАЛИ 300$", accent: "box" }];

  const cases = [
    { id: "tiger-fullai", mode: "FULL_AI" as const,
      c: concept(tigerBase, [{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }], "ЧП В ГОРОДЕ") },
    { id: "tiger-renderer", mode: "RENDERER_TEXT" as const,
      c: concept(tigerBase, [{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }], "ЧП В ГОРОДЕ") },
    { id: "money-fullai", mode: "FULL_AI" as const,
      c: concept(moneyBase, [{ text: "ДЕНЬГИ", accent: false }, { text: "СГОРЕЛИ", accent: "box" }], "ИТОГИ") },
    { id: "money-renderer", mode: "RENDERER_TEXT" as const,
      c: concept(moneyBase, moneyRendererLines, "ИТОГИ") },
  ];

  let total = 0;
  const finals: Record<string, string> = {};
  for (const t of cases) {
    const dir = path.join(OUT, t.id);
    fs.mkdirSync(dir, { recursive: true });
    const choice = selectTypographyMode(t.c.headlineLines);
    console.log(`[${t.id}] headline: ${t.c.headlineLines.map((l) => l.text).join(" / ")} | selector → ${choice.mode}${choice.reasons.length ? ` (${choice.reasons.join("; ")})` : ""}`);
    const prompt = t.mode === "FULL_AI" ? buildFullCoverPrompt(t.c) : buildCoverImagePromptFull(t.c);
    fs.writeFileSync(path.join(dir, "prompt.txt"), prompt, "utf8");
    const raw = path.join(dir, "raw.png");
    const cost = await genImage(prompt, face, raw);
    total += cost ?? 0;
    finals[t.id] = t.mode === "FULL_AI" ? raw : await renderText(raw, t.c, dir);
    console.log(`[${t.id}] OK $${cost}`);
  }

  // сравнительный лист 2×2: слева FULL_AI, справа RENDERER_TEXT
  const grid = ["tiger-fullai", "tiger-renderer", "money-fullai", "money-renderer"];
  const args: string[] = ["-y"];
  for (const id of grid) args.push("-i", finals[id]);
  const filters = grid.map((id, n) =>
    `[${n}:v]scale=480:854:force_original_aspect_ratio=increase,crop=480:854,` +
    `drawtext=text='${id.endsWith("fullai") ? "FULL AI" : "RENDERER"}':fontfile=fonts/Montserrat-Black.ttf:fontsize=30:fontcolor=white:borderw=4:bordercolor=black:x=14:y=12[t${n}]`);
  filters.push(`[t0][t1][t2][t3]xstack=inputs=4:layout=0_0|480_0|0_854|480_854[v]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-q:v", "2", path.join(OUT, "compare.jpg"));
  await run("ffmpeg", args);
  console.log(`\nTOTAL: $${total.toFixed(4)} | лист: data/cover-minitest/compare.jpg`);
}
main();
