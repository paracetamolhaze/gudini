import type { Page } from "playwright";

export type LoginSignal = { at: string; path: string; httpStatus: number; code?: string; state?: string; rateLimited: boolean };
export const LOGIN_BACKOFF_MS = 15 * 60_000;
export const LOGIN_RATE_LIMIT_MESSAGE = "TikTok отклонил QR: слишком много попыток входа. Повторные запросы остановлены. Повторите позже; срок снятия ограничения определяет TikTok.";
/** Only protocol status, never QR tokens, query strings, cookies or account data. */
export function loginSignal(url: string, httpStatus: number, body: any): LoginSignal | undefined {
  const u = new URL(url);
  if (!(u.hostname === "tiktok.com" || u.hostname.endsWith(".tiktok.com")) || !/passport.*(qr|login)|qrcode/i.test(u.pathname)) return;
  const scalar = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v)) ? String(v) : undefined;
  return { at: new Date().toISOString(), path: u.pathname, httpStatus,
    rateLimited: httpStatus === 429 || /maximum number of attempts|too many (attempts|requests)|try again later/i.test(String(body?.data?.description ?? body?.description ?? "")),
    code: scalar(body?.data?.error_code ?? body?.error_code ?? body?.status_code),
    state: scalar(body?.data?.status ?? body?.status ?? body?.message) };
}
export function observeLogin(page: Page, receive: (signal: LoginSignal) => void) {
  let stopped = false;
  page.on("response", async response => {
    if (stopped || !loginSignal(response.url(), response.status(), {})) return;
    const body = await response.json().catch(() => ({}));
    const signal = loginSignal(response.url(), response.status(), body);
    if (signal && !stopped) {
      if (signal.rateLimited) stopped = true;
      receive(signal);
      // TikTok's page keeps retrying a rejected QR itself. Closing it stops that loop.
      if (signal.rateLimited) await page.close().catch(() => {});
    }
  });
}
