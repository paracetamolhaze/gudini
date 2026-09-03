import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { UPLOADS_DIR, listProjects } from "@/lib/store";

/**
 * Диск сайта: сколько свободно, что занимают проекты, есть ли брошенные куски
 * загрузок (*.part). Появился после ENOSPC при загрузке 960 МБ: ошибка говорила
 * «нет места», но не говорила, сколько его есть и куда оно ушло.
 *
 * GET  /api/disk            — состояние
 * DELETE /api/disk?parts=1  — удалить куски загрузок старше 10 минут
 */
const STALE_PART_MS = 10 * 60 * 1000;

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

function stalePartFiles(): { file: string; bytes: number; ageMin: number }[] {
  const out: { file: string; bytes: number; ageMin: number }[] = [];
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

export function diskStatus() {
  const root = path.dirname(UPLOADS_DIR);
  let free = 0;
  let total = 0;
  try {
    const st = fs.statfsSync(root);
    free = Number(st.bavail) * Number(st.bsize);
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
    freeBytes: free,
    totalBytes: total,
    uploadsBytes: dirSize(UPLOADS_DIR),
    projects,
    stalePartFiles: stalePartFiles().filter((x) => x.ageMin >= 10),
  };
}

export async function GET() {
  return NextResponse.json(diskStatus());
}

export async function DELETE(req: NextRequest) {
  if (req.nextUrl.searchParams.get("parts") !== "1") {
    return NextResponse.json({ error: "Укажите, что удалять: ?parts=1 — брошенные куски загрузок" }, { status: 400 });
  }
  const removed: string[] = [];
  for (const x of stalePartFiles()) {
    if (x.ageMin * 60000 < STALE_PART_MS) continue;
    try {
      fs.rmSync(path.join(UPLOADS_DIR, x.file), { force: true });
      removed.push(x.file);
    } catch {}
  }
  return NextResponse.json({ removed, ...diskStatus() });
}
