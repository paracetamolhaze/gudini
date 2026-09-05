import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProject, projectDir } from "@/lib/store";
import { fileFingerprint } from "@/lib/fileFingerprint";

type Ctx = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
};

/** Отдаёт видео с поддержкой Range (перемотка в плеере). ?which=raw|processed */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const whichParam = req.nextUrl.searchParams.get("which");
  const which = whichParam === "raw" ? "raw" : whichParam === "cover" ? "cover" : "processed";
  const filename = which === "raw" ? project.rawVideo : which === "cover" ? project.cover : project.processedVideo;
  if (!filename) return NextResponse.json({ error: "Файла нет" }, { status: 404 });

  const filePath = path.join(projectDir(id), filename);
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: "Файл не найден" }, { status: 404 });

  if (which === "cover") {
    return new NextResponse(fs.createReadStream(filePath) as any, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": `inline; filename="gudini-cover.jpg"`,
      },
    });
  }

  const stat = fs.statSync(filePath);
  const mime = MIME[path.extname(filename)] ?? "video/mp4";
  const range = req.headers.get("range");
  // отпечаток исходника: воркер сверяет по нему локальную копию, а не по одному размеру
  const etag: Record<string, string> = which === "raw" ? { ETag: `"${fileFingerprint(filePath)}"` } : {};

  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      const stream = fs.createReadStream(filePath, { start, end });
      return new NextResponse(stream as any, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": mime,
          ...etag,
        },
      });
    }
  }

  const stream = fs.createReadStream(filePath);
  return new NextResponse(stream as any, {
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="gudini-${which}.mp4"`,
      ...etag,
    },
  });
}
