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
/** JS-движок для разбора плеера YouTube: node уже установлен в образе воркера. */
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node";
/**
 * Только видеодорожка: звук внешнего материала в ролик не попадает никогда.
 * Потолок 1080p: карточка 900×506 из 720p-кадра заметно мягче фото. Сюжет на
 * несколько минут в 1080p весит сотни мегабайт, а оборванное скачивание — потерянный
 * материал, поэтому 1080p берётся только когда размер известен и укладывается в
 * лимит; иначе — 720p, как раньше. Лимит файла и таймаут подняты под 1080p.
 */
const MAX_BYTES = 220_000_000;
const MAX_FILESIZE_ARG = "220M";
const VIDEO_ONLY = [
  "bv*[height<=1080][ext=mp4][filesize<200M]",
  "bv*[height<=1080][ext=mp4][filesize_approx<200M]",
  "bv*[height<=720][ext=mp4]",
  "bv*[height<=720]",
  "bv*[ext=mp4]",
  "bv*",
  "best",
].join("/");

/**
 * Есть ли экстрактор. Разовый сбой этой проверки на старте контейнера однажды
 * объявил yt-dlp «не установленным» на весь прогон: десять кандидатов пропущены,
 * ни одного стоп-кадра, а деньги на поиск и зрение потрачены. Поэтому таймаут
 * щедрый, положительный ответ запоминается, отрицательный — перепроверяется.
 */
async function hasExtractor(): Promise<boolean> {
  try {
    await run("yt-dlp", ["--version"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

let extractorAvailable: boolean | null = null;
let extractorChecks = 0;

async function extractorPresent(): Promise<boolean> {
  if (extractorAvailable === true) return true;
  if (extractorAvailable === false && extractorChecks >= 3) return false;
  extractorChecks++;
  extractorAvailable = await hasExtractor();
  return extractorAvailable;
}

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
  if (!(await extractorPresent())) return { ok: false, reason: "экстрактор не установлен" };
  try {
    await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--max-filesize", MAX_FILESIZE_ARG,
        "--socket-timeout", "20",
        "--js-runtimes", JS_RUNTIME,
        // Звук внешнего материала нам не нужен вообще, поэтому берём ТОЛЬКО видеодорожку.
        // Требование единого файла с аудио было причиной «Requested format is not available»:
        // YouTube давно отдаёт video и audio раздельно.
        "-f", VIDEO_ONLY,
        "--user-agent", UA,
        "-o", out,
        pageUrl,
      ],
      { timeout: 360_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (!fs.existsSync(out) || fs.statSync(out).size < 20_000) return { ok: false, reason: "экстрактор ничего не отдал" };
    return { ok: true, file: out, method: "extractor" };
  } catch (e: any) {
    // Показываем НАСТОЯЩУЮ ошибку yt-dlp. Раньше здесь стояла подстановка про
    // «логин/подпись», из-за которой обычный промах с форматом выглядел как защита.
    const msg = String(e?.stderr ?? e?.message ?? e)
      .split(/\r?\n/)
      .filter((l: string) => /ERROR|WARNING/i.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    for (const junk of [out, `${out}.part`]) {
      try {
        fs.rmSync(junk, { force: true });
      } catch {}
    }
    return { ok: false, reason: (msg || String(e?.message ?? e)).slice(0, 140) };
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
  if (!(await extractorPresent())) {
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
        // YouTube требует JS-движок для полного разбора плеера; node уже есть в образе,
        // но yt-dlp по умолчанию включает только deno — включаем node явно
        "--js-runtimes", JS_RUNTIME,
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
    // Настоящий текст ошибки, без пересказа: подстановка про «вход/подпись» уже
    // однажды выдала обычный промах с форматом за защиту площадки.
    const msg = String(e?.stderr ?? e?.message ?? e);
    const reason =
      msg
        .split(/\r?\n/)
        .filter((l) => /ERROR|WARNING/i.test(l))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || msg.replace(/\s+/g, " ").slice(0, 120);
    const info = { url: pageUrl, platform, ok: false, reason };
    probeLog.push(info);
    return info;
  }
}

/** Пытается получить видео: сначала прямой файл, затем экстрактор страницы. */
export type SectionFile = { index: number; start: number; end: number; file: string };

/**
 * Скачивает только нужные окна ролика, а не весь файл. Для медиатеки из каждого
 * видео берётся несколько окон по 3 секунды; тянуть ради них десятиминутный ролик
 * в 1080p — десятки мегабайт и десятки секунд впустую. yt-dlp режет по времени на
 * стороне загрузки (--download-sections), --force-keyframes-at-cuts даёт точный
 * старт куска: локальное время в файле = время в ролике минус начало окна.
 * Файлы называются по номеру окна (%(section_number)s) в порядке аргументов.
 */
export async function fetchVideoSections(
  pageUrl: string,
  sections: { index: number; start: number; end: number }[],
  outPrefix: string,
): Promise<{ ok: true; files: SectionFile[]; method: "extractor-sections" } | { ok: false; reason: string }> {
  if (!sections.length) return { ok: false, reason: "нет окон" };
  if (!(await extractorPresent())) return { ok: false, reason: "экстрактор не установлен" };
  const template = `${outPrefix}-%(section_number)s.%(ext)s`;
  try {
    await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--socket-timeout", "20",
        "--js-runtimes", JS_RUNTIME,
        "-f", VIDEO_ONLY,
        "--user-agent", UA,
        ...sections.flatMap((x) => ["--download-sections", `*${x.start.toFixed(2)}-${x.end.toFixed(2)}`]),
        "--force-keyframes-at-cuts",
        "--merge-output-format", "mp4",
        "-o", template,
        pageUrl,
      ],
      { timeout: 360_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const files: SectionFile[] = [];
    for (let n = 0; n < sections.length; n++) {
      const file = `${outPrefix}-${n + 1}.mp4`;
      if (!fs.existsSync(file) || fs.statSync(file).size < 5_000) {
        for (const f of files) fs.rmSync(f.file, { force: true });
        return { ok: false, reason: `окно ${n + 1} не скачалось` };
      }
      files.push({ index: sections[n].index, start: sections[n].start, end: sections[n].end, file });
    }
    addCost({ videoDownloads: 1 });
    return { ok: true, files, method: "extractor-sections" };
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? e);
    const reason = msg.split(/\r?\n/).filter((l) => /ERROR|WARNING/i.test(l)).join(" ").replace(/\s+/g, " ").trim().slice(0, 120) || msg.replace(/\s+/g, " ").slice(0, 120);
    return { ok: false, reason };
  }
}

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
  return extractorPresent();
}
