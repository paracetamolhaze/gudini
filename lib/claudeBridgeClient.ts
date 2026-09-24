import http from "node:http";
import https from "node:https";
import { record, type CostStage } from "./costLedger";

export type ClaudeBridgeRequest = { stage: CostStage; model: string; system: string; user: string; task: string };

/**
 * Мост Claude на Windows (threads/scripts/claude-bridge.mjs): Claude Code по подписке владельца,
 * через него уже пишет раздел Threads. Native http, как у моста Codex: у fetch/Undici пятиминутный
 * предел ожидания заголовков, а задание может постоять в очереди моста.
 */
export async function claudeBridgeComplete(request: ClaudeBridgeRequest, timeoutMs = 420_000): Promise<string> {
  if (!process.env.CLAUDE_BRIDGE_URL || !process.env.CLAUDE_BRIDGE_TOKEN) {
    throw new Error("Не заданы CLAUDE_BRIDGE_URL и CLAUDE_BRIDGE_TOKEN для моста Claude");
  }
  const url = new URL("/complete", process.env.CLAUDE_BRIDGE_URL);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Некорректный CLAUDE_BRIDGE_URL");
  const body = JSON.stringify({ system: request.system, messages: [{ role: "user", content: request.user }], task: request.task, model: request.model });
  const started = Date.now();
  const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${process.env.CLAUDE_BRIDGE_TOKEN}`,
    } }, res => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_000_000) { req.destroy(new Error("Oversized response")); return; }
        chunks.push(chunk);
      });
      res.on("error", () => { clearTimeout(timer); reject(unavailable()); });
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode || 502, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Мост Claude вернул некорректный ответ")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Timeout")), timeoutMs);
    req.on("error", () => { clearTimeout(timer); reject(unavailable()); });
    req.end(body);
  });
  const failed = status < 200 || status >= 300;
  const usage = failed ? null : data?.usage;
  // Подписка не выставляет счёт за запуск: расход виден в отчёте, цена нулевая.
  record({ stage: request.stage, provider: "anthropic", model: typeof data?.model === "string" ? data.model : request.model, requests: 1,
    inputTokens: Number(usage?.inputTokens) || 0, outputTokens: Number(usage?.outputTokens) || 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCost: 0, estimated: false,
    billing: "subscription", durationMs: Date.now() - started, failed,
  });
  if (failed) throw new Error(typeof data?.error === "string" ? `Мост Claude: ${data.error}` : "Мост Claude отклонил задание");
  if (typeof data?.text !== "string" || !data.text.trim()) throw new Error("Мост Claude вернул пустой ответ");
  return data.text.trim();
}

function unavailable(): Error {
  return new Error("Мост Claude недоступен или превышено время ожидания. Проверьте, что он запущен на Windows (npm run bridge в папке threads), и повторите задание.");
}
