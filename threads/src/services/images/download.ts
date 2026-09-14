import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * SSRF-safe image download. Only http(s); every hostname (including each redirect hop) is
 * resolved and rejected if it points at loopback, private, link-local or metadata ranges.
 * Size, content type, timeout and redirect count are bounded.
 */
export interface DownloadedImage {
  path: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  finalUrl: string;
}

export interface DownloadOptions {
  dir: string;
  filename?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: resolve host → addresses. */
  lookup?: (host: string) => Promise<string[]>;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    const inRange = (cidr: string) => {
      const [base, bits] = cidr.split("/") as [string, string];
      const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    };
    return [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "224.0.0.0/3",
    ].some(inRange);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::" ) return true;
    if (s.startsWith("fe80:") || s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    if (s.startsWith("2001:db8") || s.startsWith("ff")) return true;
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

export async function assertPublicUrl(raw: string, lookup?: DownloadOptions["lookup"]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`not a valid URL: ${raw.slice(0, 120)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError(`protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") throw new UnsafeUrlError(`host ${host} is not allowed`);
  const addresses = isIP(host) ? [host] : await (lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new UnsafeUrlError(`host ${host} did not resolve`);
  for (const a of addresses) if (isPrivateAddress(a)) throw new UnsafeUrlError(`host ${host} resolves to a private address (${a})`);
  return url;
}

async function defaultLookup(host: string): Promise<string[]> {
  try {
    const res = await dns.lookup(host, { all: true });
    return res.map((r) => r.address);
  } catch {
    return [];
  }
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export async function downloadImage(rawUrl: string, opts: DownloadOptions): Promise<DownloadedImage> {
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = await assertPublicUrl(rawUrl, opts.lookup);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      res = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; gudini-threads/0.1)", accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`redirect without location (HTTP ${res.status})`);
        if (hop === maxRedirects) throw new Error(`too many redirects (> ${maxRedirects})`);
        url = await assertPublicUrl(new URL(loc, url).toString(), opts.lookup);
        continue;
      }
      break;
    }
    if (!res) throw new Error("no response");
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error(`not an image: content-type ${type || "missing"}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error(`image too large: ${declared} bytes (max ${maxBytes})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("empty image body");
    if (buf.byteLength > maxBytes) throw new Error(`image too large: ${buf.byteLength} bytes (max ${maxBytes})`);
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error("could not read image dimensions");
    const ext = EXT[type] ?? meta.format ?? "img";
    await mkdir(opts.dir, { recursive: true });
    const file = path.join(opts.dir, opts.filename ?? `original.${ext}`);
    await writeFile(file, buf);
    return { path: file, mime: type, bytes: buf.byteLength, width: meta.width, height: meta.height, format: meta.format ?? ext, finalUrl: url.toString() };
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`image download timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
