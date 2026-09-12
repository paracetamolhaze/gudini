import { getSettings } from "../store";
import { instagramAccessToken } from "../publish";
import type { PublishState } from "./types";
import { IG_API_VERSION } from "./limits";
import { CarouselError, getCarousel, mediaQuery, notFound, updateCarousel } from "./store";
import { instagramAccountInfo } from "./account";
import { needsVerification, publishCarousel, verifyPublication, type PublishCtx } from "./instagram";

/**
 * Связка публикации с сайтом: активный аккаунт Instagram из Настроек, продление его токена
 * той же функцией, что у Reels, подписанные ссылки на слайды и сохранение каждого шага
 * в карусель. Реальная сеть — только здесь; логика шагов — в instagram.ts.
 */

function logText(s: PublishState, text: string) {
  s.log = [...s.log, { at: new Date().toISOString(), text }].slice(-60);
}

/** Остановка без обращения к Instagram: состояние не остаётся «в процессе». */
export function settlePublish(id: string, message: string): PublishState {
  return updateCarousel(id, (c) => {
    const x = c.publish;
    if (needsVerification(x)) {
      x.status = "uncertain";
      x.retryable = false;
      x.error = `${message} Исход отправленной публикации не проверен — повторная отправка заблокирована до проверки статуса.`;
    } else if (x.status !== "published") {
      x.status = "failed";
      x.stage = undefined;
      x.retryable = true;
      x.error = message;
    }
    logText(x, message);
  }).publish;
}

export async function runPublishJob(id: string, mode: "publish" | "verify", onStep?: (text: string) => void): Promise<PublishState> {
  const info = instagramAccountInfo();
  if (info.problems.length) return settlePublish(id, info.problems.join(" "));

  let token: string;
  try {
    token = await instagramAccessToken(getSettings().instagramTokens!);
  } catch (e: any) {
    return settlePublish(id, `Не удалось получить токен Instagram: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  const base = info.publicBaseUrl!.replace(/\/$/, "");
  const ctx: PublishCtx = {
    load: () => {
      const c = getCarousel(id);
      if (!c) throw notFound();
      return c.publish;
    },
    save: (mutate) => {
      const s = updateCarousel(id, (c) => mutate(c.publish)).publish;
      const last = s.log[s.log.length - 1];
      if (last && onStep) onStep(last.text);
      return s;
    },
    account: {
      token,
      igUserId: info.igUserId!,
      graph: `${info.via === "ig" ? "https://graph.instagram.com" : "https://graph.facebook.com"}/${IG_API_VERSION}`,
    },
    mediaUrl: (file) => `${base}/api/carousel/public/${id}/${file}?${mediaQuery(id, file)}`,
    deps: {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      timeoutMs: 60_000,
    },
  };

  updateCarousel(id, (c) => {
    c.publish.accountLabel = info.label ?? undefined;
  });
  try {
    return mode === "verify" ? await verifyPublication(ctx) : await publishCarousel(ctx);
  } catch (e: any) {
    if (e instanceof CarouselError && e.status === 404) throw e;
    return settlePublish(id, `Сбой публикации: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
