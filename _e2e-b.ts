// Повтор E2E B после фикса QC: первый QC принудительно провален → retry → настоящий QC.
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

const base: CoverConcept = JSON.parse(fs.readFileSync("data/cover-fullbench/tiger/concept.json", "utf8"));
const concept: CoverConcept = {
  ...base,
  headline: "ТИГР\nУ ДОМА",
  headlineLines: [{ text: "ТИГР", accent: false }, { text: "У ДОМА", accent: "box" }],
  kicker: "ЧП В ГОРОДЕ",
  typographyDirection: "ACCENT_BOX",
};
const FORCED_FAIL: CoverQcResult = { status: "EXTRA_TEXT", reasons: ["E2E: принудительный провал QC"], confidence: 0.99, cost: 0 };

async function main() {
  const dir = path.join(process.cwd(), "data", "cover-e2e", "B-retry-pass");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let calls = 0;
  const r = await buildCover(dir, concept, {
    runQc: async (f: string, h: string, k?: string) => (++calls === 1 ? FORCED_FAIL : runCoverQc(f, h, k)),
  });
  console.log(
    `\n=== E2E B (после фикса) ===\nok=${r.ok} mode=${r.mode} attempts=${r.attempts} qc=${r.qc} fallback=${r.fallbackUsed}\n` +
      `cost: gen=$${r.cost.generation.toFixed(4)} qc=$${r.cost.qc.toFixed(4)} total=$${r.cost.total.toFixed(4)}\n` +
      `артефакты: ${fs.readdirSync(dir).filter((f) => f !== "fonts").sort().join(", ")}`,
  );
  console.log("QC #2:", fs.readFileSync(path.join(dir, "cover-qc-2.json"), "utf8"));
}
main();
