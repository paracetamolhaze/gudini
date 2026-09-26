import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ENGINE_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * A private copy of the engine sources with Astra's montage in place of the kit check.
 * Lives inside the engine folder so imports resolve to the engine's node_modules.
 */
export function prepareWorkspace(code: string, name = `job-${Date.now()}`): string {
  const dir = path.join(ENGINE_ROOT, ".work", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(ENGINE_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/montage/Montage.tsx"), code, "utf8");
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    extends: path.join(ENGINE_ROOT, "tsconfig.json").replace(/\\/g, "/"),
    compilerOptions: { types: ["node"], typeRoots: [path.join(ENGINE_ROOT, "node_modules/@types").replace(/\\/g, "/")] },
    include: ["src"],
  }, null, 2));
  return dir;
}

/** TypeScript errors of the montage, with paths shortened to the file name. */
export function typecheck(dir: string): string[] {
  const tsc = path.join(ENGINE_ROOT, "node_modules/typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "--noEmit", "-p", path.join(dir, "tsconfig.json")], { cwd: dir, stdio: "pipe" });
    return [];
  } catch (error: any) {
    const output = String(error.stdout ?? "") + String(error.stderr ?? "");
    return output.split(/\r?\n/).filter(line => /error TS/.test(line))
      .map(line => line.replace(/^.*[\\/](src[\\/].*)$/, "$1"));
  }
}
