import fs from "fs";
import path from "path";
import { UPLOADS_DIR, listProjects } from "./store";

/**
 * Диск сайта: сколько свободно, что занимают проекты, есть ли брошенные куски
 * загрузок (*.part). Появился после ENOSPC при загрузке 960 МБ: ошибка говорила
 * «нет места», но не говорила, сколько его есть и куда оно ушло.
 */
export const STALE_PART_MS = 10 * 60 * 1000;

export type StalePart = { file: string; bytes: number; ageMin: number };

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {}
  return total;
}

export function stalePartFiles(): StalePart[] {
  const out: StalePart[] = [];
  try {
    for (const id of fs.readdirSync(UPLOADS_DIR)) {
      const dir = path.join(UPLOADS_DIR, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".part")) continue;
        const st = fs.statSync(path.join(dir, name));
        out.push({ file: path.join(id, name), bytes: st.size, ageMin: Math.round((Date.now() - st.mtimeMs) / 60000) });
      }
    }
  } catch {}
  return out;
}

/** Свободное место на диске (байты); -1 — узнать не удалось. */
export function freeBytes(dir: string): number {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return -1;
  }
}

export function diskStatus() {
  const root = path.dirname(UPLOADS_DIR);
  let total = 0;
  try {
    const st = fs.statfsSync(root);
    total = Number(st.blocks) * Number(st.bsize);
  } catch {}
  const projects = listProjects().map((p) => {
    const dir = path.join(UPLOADS_DIR, p.id);
    const files: Record<string, number> = {};
    try {
      for (const name of fs.readdirSync(dir)) {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile() && st.size > 1_000_000) files[name] = st.size;
      }
    } catch {}
    return { id: p.id, topic: p.topic, state: p.processing?.state ?? "idle", bytes: dirSize(dir), files };
  });
  return {
    dataDir: root,
    freeBytes: Math.max(0, freeBytes(root)),
    totalBytes: total,
    uploadsBytes: dirSize(UPLOADS_DIR),
    projects,
    stalePartFiles: stalePartFiles().filter((x) => x.ageMin >= 10),
  };
}

/** Удаляет брошенные куски загрузок старше STALE_PART_MS; возвращает список удалённых. */
export function removeStaleParts(): string[] {
  const removed: string[] = [];
  for (const x of stalePartFiles()) {
    if (x.ageMin * 60000 < STALE_PART_MS) continue;
    try {
      fs.rmSync(path.join(UPLOADS_DIR, x.file), { force: true });
      removed.push(x.file);
    } catch {}
  }
  return removed;
}
