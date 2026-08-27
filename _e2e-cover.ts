// E2E гибридного пайплайна обложек: A) PASS с первой; B) FAIL→retry→PASS; C) два FAIL→фолбэк.
import fs from "fs";
import path from "path";
import { buildCover } from "./lib/coverPipeline";
import { runCoverQc, CoverQcResult } from "./lib/coverQc";
import type { CoverConcept } from "./lib/cover";

const env = fs.readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const OUT = path.join(process.cwd(), "data", "cover-e2e");
const base: CoverConcept = JSON.parse(fs.readFileSync("data/cover-fullbench/tiger/concept.json", "utf8"));
const concept: CoverConcept = {
  ...base,
  headline: "ТИГР\nУ ДОМА",
  headlineLines: [
    { text: "ТИГР", accent: false },
    { text: "У ДОМА", accent: "box" },
  ],
  kicker: "ЧП В ГОРОДЕ",
  typographyDirection: "ACCENT_BOX",
};

const FORCED_FAIL: CoverQcResult = {
  status: "EXTRA_TEXT",
  reasons: ["E2E: принудительный провал QC"],
  confidence: 0.99,
  cost: 0,
};

async function run(name: string, deps: any) {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cover-concept.json"), JSON.stringify(concept, null, 2), "utf8");
  const t0 = Date.now();
  const r = await buildCover(dir, concept, deps);
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith("fonts")).sort();
  console.log(
    `\n=== E2E ${name} ===\n` +
      `ok=${r.ok} mode=${r.mode} attempts=${r.attempts} qc=${r.qc} fallback=${r.fallbackUsed}\n` +
      `cost: gen=$${r.cost.generation.toFixed(4)} qc=$${r.cost.qc.toFixed(4)} total=$${r.cost.total.toFixed(4)} | ${((Date.now() - t0) / 1000).toFixed(1)}s\n` +
      `артефакты: ${files.join(", ")}`,
  );
  return r;
}

async function main() {
  // A: обычный production-путь, всё настоящее
  await run("A-pass-first", {});

  // B: первый QC принудительно проваливаем, второй — настоящий
  let qcCalls = 0;
  await run("B-retry-pass", {
    runQc: async (file: string, headline: string, kicker?: string) =>
      ++qcCalls === 1 ? FORCED_FAIL : runCoverQc(file, headline, kicker),
  });

  // C: оба QC проваливаем → обязан быть фолбэк на чистую картинку + наш рендерер
  await run("C-fallback", { runQc: async () => FORCED_FAIL });
}
main();
