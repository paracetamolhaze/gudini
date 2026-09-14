import fs from "node:fs";
import path from "node:path";

async function main() {
  const source = process.argv[2];
  if (!source) throw new Error("Usage: recheck-planner-run <saved-run> [--live] [--limit=0.20]");
  const live = process.argv.includes("--live");
  const responseFile = process.argv.find(a => a.startsWith("--response="))?.slice(11);
  if (live && fs.existsSync(".env")) process.loadEnvFile(".env");
  const { planFilm, planKey } = await import("../lib/aiFilm/run");
  const { compilerFingerprint } = await import("../lib/aiFilm/plan");
  const { loadCharacterProfile } = await import("../lib/aiFilm/character");
  const { loadUniverseProfile } = await import("../lib/aiFilm/universe");
  const { mediaComplete } = await import("../lib/mediaLlm");
  const { STORY_MODEL } = await import("../lib/aiFilm/story");
  const { gateIssues } = await import("../lib/aiFilm/criteria");
  const { resetLedger, setRunCostLimit, ledger } = await import("../lib/costLedger");
  const input = JSON.parse(fs.readFileSync(path.join(source, "input.json"), "utf8"));
  const character = loadCharacterProfile(), universe = loadUniverseProfile();
  const dir = path.join(source, `${live ? "live" : "offline"}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  resetLedger();
  setRunCostLimit(Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? 0.20));
  let calls = 0;
  try {
    const result = await planFilm({ ...input, character, universe,
      cfg: { ...input.cfg, universe, key: planKey(input.words, input.script, character, universe, input.duration, compilerFingerprint(character, universe)) },
      complete: async ({ system, user }) => {
        calls++;
        if (calls === 1) return fs.readFileSync(path.join(source, "01-first-raw.json"), "utf8");
        if (calls > 2) throw new Error("More than one correction");
        fs.writeFileSync(path.join(dir, "correction-system.txt"), system);
        fs.writeFileSync(path.join(dir, "correction-user.txt"), user);
        const raw = live ? await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", reasoning: "off", system, user }) : fs.readFileSync(responseFile ?? path.join(source, "02-retry-raw.json"), "utf8");
        fs.writeFileSync(path.join(dir, "correction-raw.json"), raw);
        return raw;
      },
    });
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    const blocks = gateIssues(result.plan);
    console.log(JSON.stringify({ dir, reusedFirst: true, calls, blocks, accepted: result.accepted }));
    if (blocks.length) process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(dir, "spend.json"), JSON.stringify({ ledger: ledger(), cost: ledger().reduce((s, c) => s + c.estimatedCost, 0) }, null, 2));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
