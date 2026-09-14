import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The code runs either from src/ (tsx) or from dist/src/ (tsc build); project-level folders
 * (migrations, web/dist) sit one level higher in the second case. Pick whichever exists.
 */
export function projectDir(fromDir: string, relative: string): string {
  const candidates = [path.resolve(fromDir, "../..", relative), path.resolve(fromDir, "../../..", relative)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}
