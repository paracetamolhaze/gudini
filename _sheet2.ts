// Слепой лист A–L: ряд = сценарий, порядок внутри ряда перемешан. Только сырой выход моделей.
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
const run = promisify(execFile);

const OUT = path.join(process.cwd(), "data", "cover-fullbench");
const ROWS: Record<string, string[]> = {
  tiger: ["pro-2", "flash-1", "pro-1", "flash-2"],
  money: ["flash-2", "pro-1", "flash-1", "pro-2"],
  genes: ["pro-1", "flash-2", "pro-2", "flash-1"],
};

async function main() {
  const letters = "ABCDEFGHIJKL";
  const inputs: string[] = [];
  const mapping: string[] = [];
  let i = 0;
  for (const [scenario, order] of Object.entries(ROWS)) {
    for (const key of order) {
      inputs.push(path.join(OUT, scenario, `${key}.png`));
      mapping.push(`${letters[i]} = ${scenario}/${key}`);
      i++;
    }
  }
  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);
  const filters = inputs.map((_, n) =>
    `[${n}:v]scale=384:688,drawtext=text='${letters[n]}':fontfile=fonts/Montserrat-Black.ttf:fontsize=64:fontcolor=white:borderw=5:bordercolor=black:x=18:y=14[t${n}]`
  );
  const layout = inputs.map((_, n) => `${(n % 4) * 384}_${Math.floor(n / 4) * 688}`).join("|");
  filters.push(`${inputs.map((_, n) => `[t${n}]`).join("")}xstack=inputs=12:layout=${layout}[v]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-q:v", "2", path.join(OUT, "blind-sheet.jpg"));
  await run("ffmpeg", args);
  fs.writeFileSync(path.join(OUT, "mapping.txt"), mapping.join("\n"), "utf8");
  console.log("OK\n" + mapping.join("\n"));
}
main();
