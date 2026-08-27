import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { addCost } from "./pipelineCost";

const run = promisify(execFile);

/**
 * Получение видеофайла по публичному адресу.
 *
 * Два пути: прямая ссылка на файл скачивается обычным запросом, а страница с плеером
 * отдаётся универсальному экстрактору (yt-dlp), который умеет сотни сайтов со штатными
 * HLS/MP4 — новостные CMS, архивы, официальные порталы.
 *
 * Мы не добавляем ничего, что обходит защиту потока: если площадка отдаёт видео только
 * после расшифровки подписи в плеере или требует логин, экстрактор честно вернёт ошибку,
 * и мы просто перейдём к следующему кандидату. Чужие cookies не используются.
 */

export type FetchResult = {
  ok: boolean;
  file?: string;
  durationSec?: number;
  method?: "direct" | "extractor";
  reason?: string;
};

const UA = "Gudini/1.0 (short-video editor)";
const MAX_BYTES = 90_000_000;

async function hasExtractor(): Promise<boolean> {
  try {
    await run("yt-dlp", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

let extractorAvailable: boolean | null = null;

/** Прямое скачивание файла. */
async function direct(url: string, out: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > MAX_BYTES) return { ok: false, reason: "слишком большой файл" };
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 20_000) return { ok: false, reason: "пустой файл" };
    if (buffer.length > MAX_BYTES) return { ok: false, reason: "слишком большой файл" };
    fs.writeFileSync(out, buffer);
    return { ok: true, file: out, method: "direct" };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 90) };
  }
}

/**
 * Универсальный экстрактор для страниц с плеером.
 * Ограничиваем качество, чтобы не тянуть гигабайты, и берём только то,
 * что отдаётся без логина.
 */
async function viaExtractor(pageUrl: string, out: string): Promise<FetchResult> {
  if (extractorAvailable === null) extractorAvailable = await hasExtractor();
  if (!extractorAvailable) return { ok: false, reason: "экстрактор не установлен" };
  try {
    await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--max-filesize", "90M",
        "--socket-timeout", "20",
        "-f", "best[height<=720][ext=mp4]/best[height<=720]/best",
        "--user-agent", UA,
        "-o", out,
        pageUrl,
      ],
      { timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (!fs.existsSync(out) || fs.statSync(out).size < 20_000) return { ok: false, reason: "экстрактор ничего не отдал" };
    return { ok: true, file: out, method: "extractor" };
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    // площадка требует логин/подпись/токен — это не наш случай, идём дальше
    const why = /cookies|sign in|login|private|DRM|PO Token|not available/i.test(msg)
      ? "поток недоступен без входа/подписи"
      : msg.slice(0, 90);
    return { ok: false, reason: why };
  }
}

/** Пытается получить видео: сначала прямой файл, затем экстрактор страницы. */
export async function fetchVideo(directUrl: string | undefined, pageUrl: string, out: string): Promise<FetchResult> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (directUrl && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(directUrl)) {
    const r = await direct(directUrl, out);
    if (r.ok) {
      addCost({ videoDownloads: 1 });
      return r;
    }
  }
  const r = await viaExtractor(pageUrl, out);
  if (r.ok) addCost({ videoDownloads: 1 });
  return r;
}

export async function extractorReady(): Promise<boolean> {
  if (extractorAvailable === null) extractorAvailable = await hasExtractor();
  return extractorAvailable;
}
