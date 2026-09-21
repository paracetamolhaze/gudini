import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSettings, saveSettings, MODES } from "../../config/settings.js";
import { audit } from "../../services/audit.js";
import { HttpError } from "../server.js";
import { env } from "../../config/env.js";

export function registerSettingsRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/settings`, async () => {
    const settings = await loadSettings(true);
    const e = env();
    return {
      settings,
      env: {
        // presence only — values never leave the server
        threadsToken: Boolean(e.THREADS_ACCESS_TOKEN),
        xKeys: { apiKey: Boolean(e.X_API_KEY), apiSecret: Boolean(e.X_API_SECRET), accessToken: Boolean(e.X_ACCESS_TOKEN), accessSecret: Boolean(e.X_ACCESS_SECRET) },
        hyperliquidWalletEnv: Boolean(e.HYPERLIQUID_WALLET),
        coingeckoKey: Boolean(e.COINGECKO_API_KEY),
        llmProvider: e.LLM_PROVIDER,
        keys: {
          openrouter: Boolean(e.OPENROUTER_API_KEY || (e.LLM_PROVIDER === "openrouter" && e.LLM_API_KEY)),
          openai: Boolean(e.OPENAI_API_KEY || (e.LLM_PROVIDER === "openai" && e.LLM_API_KEY)),
          anthropic: Boolean(e.ANTHROPIC_API_KEY || (e.LLM_PROVIDER === "anthropic" && e.LLM_API_KEY)),
          gemini: Boolean(e.GEMINI_API_KEY || (e.LLM_PROVIDER === "gemini" && e.LLM_API_KEY)),
        },
        sitePasswordSet: Boolean(e.SITE_PASSWORD),
        publicBaseUrl: e.PUBLIC_BASE_URL ?? null,
      },
    };
  });

  app.put(`${api}/settings`, async (req) => {
    const body = req.body;
    if (!body || typeof body !== "object") throw new HttpError(400, "settings patch must be a JSON object");
    const before = await loadSettings(true);
    const after = await saveSettings(body);
    const changed = Object.keys(body as Record<string, unknown>);
    await audit("SETTINGS_CHANGED", `Настройки изменены: ${changed.join(", ")}`, {}, { changed });
    if (before.mode !== after.mode) await audit("MODE_CHANGED", `Режим ${before.mode} → ${after.mode}`, {}, { from: before.mode, to: after.mode }, "warn");
    return { settings: after };
  });

  const modeBody = z.object({ mode: z.enum(MODES) });
  app.post(`${api}/mode`, async (req) => {
    const parsed = modeBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
    const before = await loadSettings(true);
    const after = await saveSettings({ mode: parsed.data.mode });
    await audit("MODE_CHANGED", `Режим ${before.mode} → ${after.mode}`, {}, { from: before.mode, to: after.mode }, "warn");
    return { mode: after.mode };
  });

  app.post(`${api}/kill-switch`, async (req) => {
    const stop = (req.body as { stop?: unknown } | null)?.stop !== false;
    const after = await saveSettings({ killSwitch: stop });
    await audit(
      "KILL_SWITCH",
      stop ? "STOP AUTOPILOT: публикации, ответы и engagement остановлены" : "Kill switch снят: автопилот снова может действовать",
      {},
      { killSwitch: stop },
      stop ? "error" : "warn",
    );
    return { killSwitch: after.killSwitch };
  });
}
