// Full-AI Cover benchmark: Flash vs Pro, 3 сценария × 2 генерации, модель рисует ВСЮ обложку с текстом
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { generateCoverConcept } from "./lib/cover";
import { buildFullCoverPrompt } from "./lib/coverPrompt";
import { probe } from "./lib/ffmpeg";

const env = fs.readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const KEY = process.env.OPENROUTER!;
const OUT = path.join(process.cwd(), "data", "cover-fullbench");

const MODELS = [
  { id: "google/gemini-3.1-flash-image", dir: "flash" },
  { id: "google/gemini-3-pro-image", dir: "pro" },
];

const SCENARIOS = [
  { name: "tiger", topic: "В Москве выпустили тигра: что делать при встрече с диким зверем",
    script: "Представь: ты выходишь за хлебом, а посреди двора стоит тигр. Животные реально сбегают из цирков. Не беги — бег включает инстинкт погони. Уйди за преграду и звони сто двенадцать." },
  { name: "money", topic: "Я вложил 5000 долларов в мем-коины и вот что вышло",
    script: "Я вложил пять тысяч долларов в мем-коины, о которых кричал весь интернет. Через месяц от них осталось триста долларов. Три ошибки сожгли мой депозит — не повтори их." },
  { name: "genes", topic: "Учёные начали редактировать ДНК младенцев до рождения",
    script: "Пока ты спал, наука перешла черту: гены младенцев теперь редактируют до рождения. Богатые смогут заказывать детям интеллект и здоровье. Равенство закончилось." },
];

async function gen(model: string, prompt: string, faceB64: string) {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${faceB64}` } },
      ]}],
      modalities: ["image", "text"],
      usage: { include: true },
    }),
  });
  const latency = Date.now() - t0;
  const json: any = await res.json();
  if (!res.ok || json.error) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 150)}`);
  const img = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!img?.startsWith("data:")) throw new Error("нет изображения");
  return { buffer: Buffer.from(img.slice(img.indexOf(",") + 1), "base64"), latency, usage: json.usage ?? null };
}

async function main() {
  const face = fs.readFileSync(path.join(process.cwd(), "data", "face.jpg"));
  console.log("reference sha256:", crypto.createHash("sha256").update(face).digest("hex").slice(0, 16), "…");
  fs.mkdirSync(OUT, { recursive: true });

  const results: any[] = [];
  for (const s of SCENARIOS) {
    const concept = await generateCoverConcept(s.topic, s.script, null);
    if (!concept) throw new Error(`концепт ${s.name} не сгенерировался`);
    const sdir = path.join(OUT, s.name);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "concept.json"), JSON.stringify(concept, null, 2), "utf8");
    const prompt = buildFullCoverPrompt(concept);
    fs.writeFileSync(path.join(sdir, "prompt.txt"), prompt, "utf8");
    console.log(`\n[${s.name}] headline: ${concept.headlineLines.map((l) => l.text).join(" / ")} | dir=${concept.typographyDirection} | prompt=${prompt.length}ch`);

    for (const m of MODELS) {
      for (const g of [1, 2]) {
        const tag = `${s.name}/${m.dir}#${g}`;
        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
          try {
            const r = await gen(m.id, prompt, face.toString("base64"));
            const file = path.join(sdir, `${m.dir}-${g}.png`);
            fs.writeFileSync(file, r.buffer);
            const info = await probe(file);
            const meta = { scenario: s.name, model: m.id, gen: g, latency_ms: r.latency, width: info.width, height: info.height, filesize: r.buffer.length, cost: r.usage?.cost ?? null };
            fs.writeFileSync(path.join(sdir, `${m.dir}-${g}-meta.json`), JSON.stringify(meta, null, 2));
            results.push(meta);
            console.log(`${tag}: OK ${info.width}x${info.height} ${r.latency}ms $${meta.cost}`);
            ok = true;
          } catch (e: any) {
            console.warn(`${tag}: попытка ${attempt} — ${String(e.message).slice(0, 120)}`);
            await new Promise((res) => setTimeout(res, 2500));
          }
        }
        if (!ok) results.push({ scenario: s.name, model: m.id, gen: g, error: true });
      }
    }
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const total = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  console.log(`\nTOTAL COST: $${total.toFixed(4)}`);
}
main();
