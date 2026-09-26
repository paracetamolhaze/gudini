import http from "node:http";

export type BridgeImage = { base64: string; mediaType: string };
export type BridgeResult = { text: string; runId: string; durationMs: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } };

/**
 * Calls Astra (GPT-6 via the local Codex service on Windows). The service checks that the
 * model and effort match its own settings, so they come from the same variables.
 */
export async function askAstra(system: string, user: string, images: BridgeImage[] = [], timeoutMs = 25 * 60_000): Promise<BridgeResult> {
  const token = process.env.CODEX_BRIDGE_TOKEN;
  if (!token) throw new Error("Не задан CODEX_BRIDGE_TOKEN для локального сервиса Codex");
  const url = new URL("/complete", process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:43127");
  const body = JSON.stringify({
    stage: "Creative Director",
    model: process.env.CODEX_MODEL || "gpt-6-astra",
    effort: process.env.CODEX_REASONING_EFFORT || "high",
    system, user,
    ...(images.length ? { images } : {}),
  });
  const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token}`,
    } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode ?? 502, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Сервис Codex вернул некорректный ответ")); }
      });
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("Сервис Codex не ответил вовремя")), timeoutMs);
    req.on("error", reject);
    req.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`Сервис Codex: ${typeof data?.error === "string" ? data.error : status}`);
  if (typeof data?.text !== "string" || !data.text.trim()) throw new Error("Сервис Codex вернул пустой ответ");
  return data as BridgeResult;
}

/** The answer is the whole file; tolerate a stray code fence around it. */
export function extractCode(text: string): string {
  const fenced = text.match(/```(?:tsx|typescript|ts)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim() + "\n";
}

/** POST to the local Codex service; `/image` draws a picture with the owner's subscription. */
export async function postBridge<T>(pathname: string, payload: unknown, timeoutMs: number, base = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:43127"): Promise<T> {
  const token = process.env.CODEX_BRIDGE_TOKEN;
  if (!token) throw new Error("Не задан CODEX_BRIDGE_TOKEN для локального сервиса Codex");
  const url = new URL(pathname, base);
  const body = JSON.stringify(payload);
  const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token}` } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode ?? 502, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Сервис Codex вернул некорректный ответ")); }
      });
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("Сервис Codex не ответил вовремя")), timeoutMs);
    req.on("error", reject);
    req.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`Сервис Codex: ${typeof data?.error === "string" ? data.error : status}`);
  return data as T;
}
