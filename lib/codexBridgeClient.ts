import http from "node:http";
import https from "node:https";
import { record } from "./costLedger";
import type { CodexRequest, CodexResult } from "./codexLlm";

/** Native http avoids fetch/Undici's five-minute response-header limit for queued jobs. */
export async function bridgeComplete(request: CodexRequest, timeoutMs: number): Promise<CodexResult> {
  if (!process.env.CODEX_BRIDGE_TOKEN) throw new Error("Не задан CODEX_BRIDGE_TOKEN для локального сервиса Codex");
  const url = new URL("/complete", process.env.CODEX_BRIDGE_URL);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Некорректный CODEX_BRIDGE_URL");
  const body = JSON.stringify(request);
  const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${process.env.CODEX_BRIDGE_TOKEN}`,
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
        catch { reject(new Error("Локальный сервис Codex вернул некорректный ответ")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Timeout")), timeoutMs);
    req.on("error", () => { clearTimeout(timer); reject(unavailable()); });
    req.end(body);
  });
  const failed = status < 200 || status >= 300;
  const run = failed ? data.run : data;
  if (validRun(run)) {
    record({ stage: request.stage, provider: "codex", model: request.model, requests: 1,
      inputTokens: Math.max(0, run.usage.inputTokens - run.usage.cacheReadTokens), outputTokens: run.usage.outputTokens,
      cacheReadTokens: run.usage.cacheReadTokens, cacheCreationTokens: 0, estimatedCost: 0, estimated: false,
      billing: "subscription", runId: run.runId, durationMs: run.durationMs, failed,
    });
  }
  if (failed) throw new Error(typeof data.error === "string" ? data.error : "Локальный сервис Codex отклонил задание");
  if (!validRun(data) || typeof data.text !== "string" || !data.text.trim()) throw new Error("Локальный сервис Codex вернул некорректный ответ");
  return data as CodexResult;
}

function validRun(data: any): data is CodexResult {
  return data && typeof data.runId === "string" && Number.isFinite(data.durationMs) && data.durationMs >= 0 && data.usage &&
    [data.usage.inputTokens, data.usage.outputTokens, data.usage.cacheReadTokens].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0);
}
function unavailable(): Error {
  return new Error("Локальный сервис Codex недоступен или превышено время ожидания. Запустите deploy/start-codex-bridge.ps1 на Windows и повторите задание.");
}
