import { NextRequest, NextResponse } from "next/server";
import { diskStatus, removeStaleParts } from "@/lib/diskStatus";

/**
 * GET    /api/disk          — свободное место, размеры проектов, брошенные куски загрузок
 * DELETE /api/disk?parts=1  — удалить куски загрузок старше 10 минут
 */
export async function GET() {
  return NextResponse.json(diskStatus());
}

export async function DELETE(req: NextRequest) {
  if (req.nextUrl.searchParams.get("parts") !== "1") {
    return NextResponse.json({ error: "Укажите, что удалять: ?parts=1 — брошенные куски загрузок" }, { status: 400 });
  }
  const removed = removeStaleParts();
  return NextResponse.json({ removed, ...diskStatus() });
}
