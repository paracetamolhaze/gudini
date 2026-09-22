import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { audit } from "../../services/audit.js";
import { errorMessage } from "../../shared/logger.js";
import { xBrowser } from "../../x/browser/client.js";
import { forgetXSessionCache } from "../../platforms/xBrowser.js";
import { HttpError } from "../server.js";

/**
 * The owner's window into the X browser container. He signs in himself: we send him JPEG frames of
 * the real page and forward his clicks and keystrokes back. No password is ever typed into our forms,
 * stored by us, or seen by the service — X receives it directly, exactly as in a normal browser.
 */
const InputBody = z.union([
  z.object({ type: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("drag"), x: z.number(), y: z.number(), toX: z.number(), toY: z.number() }),
  z.object({ type: z.literal("text"), text: z.string().max(1000) }),
  z.object({ type: z.literal("key"), key: z.enum(["Tab", "Enter", "Backspace", "Escape", "ControlOrMeta+A", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) }),
  z.object({ type: z.literal("scroll"), dy: z.number() }),
  z.object({ type: z.literal("back") }),
]);

/** The container speaks its own error language; the dashboard only needs a sentence and a code. */
async function forward<T>(action: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  try {
    return await xBrowser().call<T>(action, body, timeoutMs);
  } catch (err) {
    throw new HttpError(502, errorMessage(err));
  }
}

export function registerXBrowserRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/x-browser/status`, async () => {
    if (env().X_TRANSPORT !== "browser") return { transport: "api" as const, connected: false, username: null, login: false, busy: false, issue: null, error: "" };
    try {
      return { transport: "browser" as const, ...(await xBrowser().status()) };
    } catch (err) {
      // A stopped container is a normal state right after a restart, not a page-breaking error.
      return { transport: "browser" as const, connected: false, username: null, login: false, busy: false, issue: null, error: errorMessage(err) };
    }
  });

  app.post(`${api}/x-browser/login`, async () => {
    await audit("X_LOGIN_OPENED", "Открыто окно входа в X");
    return forward("login", {}, 90_000);
  });

  app.get(`${api}/x-browser/frame`, async () => forward<{ image: string; url: string }>("frame", {}, 30_000));

  app.post(`${api}/x-browser/input`, async (req) => {
    const parsed = InputBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Неизвестное действие окна входа");
    return forward("input", parsed.data as unknown as Record<string, unknown>, 30_000);
  });

  app.post(`${api}/x-browser/finish`, async () => {
    const res = await forward<{ username: string | null }>("finish", {}, 120_000);
    forgetXSessionCache();
    await audit("X_CONNECTED", `X подключён: @${res.username ?? "?"}`);
    return res;
  });

  app.post(`${api}/x-browser/close`, async () => forward("close", {}, 30_000));

  app.post(`${api}/x-browser/disconnect`, async () => {
    const res = await forward("disconnect", {}, 60_000);
    forgetXSessionCache();
    await audit("X_DISCONNECTED", "X отключён, профиль браузера удалён");
    return res;
  });

  /**
   * What the live page actually contains. X is rewriting its front end, so this is how we learn the
   * current markup from the owner's own session instead of guessing at it.
   */
  app.post(`${api}/x-browser/probe`, async (req) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (url !== undefined && (typeof url !== "string" || !/^https:\/\/x\.com\//.test(url))) throw new HttpError(400, "Адрес должен начинаться с https://x.com/");
    return forward("probe", url ? { url } : {}, 90_000);
  });
}
