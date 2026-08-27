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

export type ProbeInfo = {
  url: string;
  platform: string;
  extractor?: string;
  ok: boolean;
  durationSec?: number;
  title?: string;
  formats?: number;
  reason?: string;
};

/** Журнал всех обращений к экстрактору — для отчёта по retrieval. */
export const probeLog: ProbeInfo[] = [];
export function resetProbeLog(): void {
  probeLog.length = 0;
}

function platformOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Разведка ролика БЕЗ скачивания: есть ли доступные форматы, какая длительность.
 * Решение принимается по конкретному URL, а не по домену: площадка не блокируется
 * заранее, но если поток отдаётся только после входа или подписи — идём дальше.
 */
export async function probeVideo(pageUrl: string): Promise<ProbeInfo> {
  const platform = platformOf(pageUrl);
  if (extractorAvailable === null) extractorAvailable = await hasExtractor();
  if (!extractorAvailable) {
    const info = { url: pageUrl, platform, ok: false, reason: "экстрактор не установлен" };
    probeLog.push(info);
    return info;
  }
  addCost({ ytdlpProbes: 1 });
  try {
    const { stdout } = await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--socket-timeout", "15",
        "--print", "%(extractor)s\t%(duration)s\t%(format_count)s\t%(title).80s",
        "--user-agent", UA,
        pageUrl,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const [extractor, dur, formats, title] = String(stdout).trim().split("\n")[0].split("\t");
    const info: ProbeInfo = {
      url: pageUrl,
      platform,
      extractor,
      ok: true,
      durationSec: Number(dur) || undefined,
      formats: Number(formats) || undefined,
      title,
    };
    probeLog.push(info);
    addCost({ ytdlpSuccesses: 1 });
    return info;
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    const reason = /cookies|sign in|log in|login|private|DRM|PO Token|not available|age|bot/i.test(msg)
      ? "поток недоступен без входа/подписи"
      : /Unsupported URL/i.test(msg)
        ? "площадка не поддерживается экстрактором"
        : msg.replace(/\s+/g, " ").slice(0, 110);
    const info = { url: pageUrl, platform, ok: false, reason };
    probeLog.push(info);
    return info;
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
