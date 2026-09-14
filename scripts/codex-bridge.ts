import fs from "node:fs";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

async function main() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  // The bridge executes locally even if the user's shell inherited a Docker URL.
  delete process.env.CODEX_BRIDGE_URL;
  const token = process.env.CODEX_BRIDGE_TOKEN || "";
  if (token.length < 32) throw new Error("CODEX_BRIDGE_TOKEN должен содержать минимум 32 символа");
  const { codexComplete, codexModel, codexEffort } = await import("../lib/codexLlm");
  const { isAllowed } = await import("../lib/providerPolicy");
  const { resetLedger } = await import("../lib/costLedger");
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: "Нет доступа к локальному сервису Codex" }); return; }
    if (req.method === "GET" && req.url === "/health") { send(200, { ok: true, service: "gudini-codex", scriptModel: codexModel("Script Generation"), storyModel: codexModel("AI Film Story") }); return; }
    if (req.method !== "POST" || req.url !== "/complete") { send(404, { error: "Unknown route" }); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 50_000_000) { send(413, { error: "Задание Codex больше 50 МБ" }); return; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof data.system !== "string" || typeof data.user !== "string" || !isAllowed(data.stage, "codex") ||
        data.system.length + data.user.length > 500_000 ||
        (data.images !== undefined && (!Array.isArray(data.images) || data.images.length > 24 || data.images.some((image: any) =>
          !image || !((typeof image.base64 === "string" && typeof image.mediaType === "string") || typeof image.url === "string"))))) {
        send(400, { error: "Некорректное задание Codex" }); return;
      }
      // Models and effort must agree with host settings, preventing silent provenance mismatch.
      if (data.model !== codexModel(data.stage) || data.effort !== codexEffort(data.stage)) {
        send(409, { error: "Настройки модели Codex на сайте и Windows различаются. Перезапустите сервис Codex и контейнеры после изменения .env." }); return;
      }
      const result = await codexComplete(data);
      send(200, result);
    } catch (error: any) {
      const safe = error instanceof Error && /^(Codex|Лимит подписки|Очередь Codex)/.test(error.message);
      send(502, { error: safe ? error.message : "Локальный сервис Codex не смог обработать задание", run: error.codexRun });
    } finally { resetLedger(); } // The bridge persists per-run files; accounting belongs to the caller.
  });
  server.requestTimeout = 60_000; // Receiving the body, not waiting for generation.
  server.headersTimeout = 15_000;
  server.listen(Number(process.env.CODEX_BRIDGE_PORT || 43127), "0.0.0.0", () => console.log("Gudini Codex bridge ready"));
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
