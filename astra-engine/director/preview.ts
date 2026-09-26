// Stills of a montage at chosen seconds, with its emoji, logos, photos and cutouts prepared.
// npx tsx director/preview.ts --montage m.tsx --input in.json --public public --media dev/x --out out/x 1.5 9.8 30
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { astraInputSchema } from "../src/input";
import { resolveAssets } from "./assets";
import { makeCutouts } from "./matting";
import { analyzeMontage, assetNeeds, cutoutRanges } from "./validate";
import { prepareWorkspace, typecheck } from "./workspace";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const publicDir = path.resolve(arg("public", "public")!);
  const out = path.resolve(arg("out", "out/preview")!);
  const code = fs.readFileSync(path.resolve(arg("montage")!), "utf8");
  const times = process.argv.slice(2).filter((a, i, all) => /^\d+(\.\d+)?$/.test(a) && !all[i - 1]?.startsWith("--"));
  let input = astraInputSchema.parse(JSON.parse(fs.readFileSync(path.resolve(arg("input")!), "utf8")));
  const analysis = analyzeMontage(code, input.duration);
  const workspace = prepareWorkspace(code, "preview");
  const problems = [...analysis.problems, ...typecheck(workspace)];
  if (problems.length) throw new Error(problems.join("\n"));
  const resolved = await resolveAssets(assetNeeds(analysis.blocks), publicDir, "asset-cache", { video: path.join(publicDir, input.video), face: input.face, drawMissingPhotos: true });
  if (resolved.missing.length) console.log(resolved.missing.join("\n"));
  const cutouts = makeCutouts({ video: path.join(publicDir, input.video), publicDir, subdir: `${arg("media", "dev")}/cutouts`, ranges: cutoutRanges(analysis.blocks, input.duration) });
  input = { ...input, assets: { ...input.assets, ...resolved.assets }, sizes: { ...input.sizes, ...resolved.sizes }, cutouts };
  const serveUrl = await bundle({ entryPoint: path.join(workspace, "src/index.ts"), publicDir });
  const inputProps = input as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "Astra", inputProps });
  fs.mkdirSync(out, { recursive: true });
  for (const t of times.map(Number)) {
    const output = path.join(out, `still-${t.toFixed(1)}.png`);
    await renderStill({ serveUrl, composition, inputProps, frame: Math.round(t * composition.fps), output });
    console.log(output);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
