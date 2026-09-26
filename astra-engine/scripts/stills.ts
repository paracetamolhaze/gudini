// Renders stills at given seconds: npx tsx scripts/stills.ts out/dir 1.2 3.5 10
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

async function main() {
  const [outDir, ...times] = process.argv.slice(2);
  const root = path.resolve(import.meta.dirname, "..");
  const serveUrl = await bundle({ entryPoint: path.join(root, "src/index.ts"), publicDir: path.join(root, "public") });
  const composition = await selectComposition({ serveUrl, id: "Astra" });
  for (const time of times.map(Number)) {
    const frame = Math.round(time * composition.fps);
    const output = path.resolve(outDir, `still-${time.toFixed(1)}.png`);
    await renderStill({ serveUrl, composition, frame, output, imageFormat: "png" });
    console.log(output);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
