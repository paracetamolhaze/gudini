import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "./workspace";

/**
 * Cuts the author out for every range (text behind the author) and returns the cutout list
 * for the input. Ranges already cut earlier in this job are reused.
 */
export function makeCutouts(opts: { video: string; publicDir: string; subdir: string; ranges: { from: number; to: number }[] }) {
  const python = process.env.ASTRA_PYTHON ?? "python3";
  const model = process.env.ASTRA_RVM_MODEL ?? path.join(ENGINE_ROOT, "matting/rvm_mobilenetv3_fp32.onnx");
  const dir = path.join(opts.publicDir, opts.subdir);
  fs.mkdirSync(dir, { recursive: true });
  return opts.ranges.map(range => {
    const name = `cutout-${range.from.toFixed(2)}-${range.to.toFixed(2)}.webm`;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      execFileSync(python, [path.join(ENGINE_ROOT, "matting/cutout.py"), "--video", opts.video, "--start", range.from.toFixed(3),
        "--end", range.to.toFixed(3), "--out", file, "--model", model], { stdio: "inherit" });
    }
    return { from: range.from, to: range.to, src: `${opts.subdir}/${name}` };
  });
}
