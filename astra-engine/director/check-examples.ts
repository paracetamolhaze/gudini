// Every worked example must compile and pass the same checks as Astra's montages.
import { loadExamples } from "./knowledge";
import { analyzeMontage } from "./validate";
import { prepareWorkspace, typecheck } from "./workspace";

let failed = false;
for (const example of loadExamples()) {
  const analysis = analyzeMontage(example.code, example.duration);
  const errors = typecheck(prepareWorkspace(example.code, `example-${example.name}`));
  const bad = [...analysis.problems, ...errors];
  console.log(`${example.name}: ${analysis.blocks.length} blocks, ${analysis.camera.length} camera moves, ${bad.length ? "FAIL" : "ok"}`);
  for (const line of [...bad, ...analysis.notes.map(n => `note: ${n}`)]) console.log(`  ${line}`);
  if (bad.length) failed = true;
}
process.exitCode = failed ? 1 : 0;
