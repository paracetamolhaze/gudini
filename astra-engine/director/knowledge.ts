import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "./workspace";

const dir = path.join(ENGINE_ROOT, "knowledge");

export type Example = { name: string; text: string; code: string; duration: number };

/** Worked examples: transcript plus the montage a strong editor would make. */
export function loadExamples(): Example[] {
  return fs.readdirSync(path.join(dir, "examples")).filter(f => f.endsWith(".md")).sort().map(file => {
    const text = fs.readFileSync(path.join(dir, "examples", file), "utf8");
    const code = text.match(/```tsx\n([\s\S]*?)```/)?.[1] ?? "";
    const times = [...text.matchAll(/@(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
    return { name: file.replace(/\.md$/, ""), text, code, duration: Math.max(0, ...times) + 1.5 };
  });
}

export function loadGuide(): { director: string; kit: string } {
  return {
    director: fs.readFileSync(path.join(dir, "director.md"), "utf8"),
    kit: fs.readFileSync(path.join(dir, "kit.md"), "utf8"),
  };
}
