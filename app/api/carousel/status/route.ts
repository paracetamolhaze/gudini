import { NextRequest } from "next/server";
import { guard, ok } from "@/lib/carousel/http";
import { instagramAccountInfo } from "@/lib/carousel/account";
import { CAROUSEL_LIMITS, IG_LIMITS } from "@/lib/carousel/limits";
import { runnerState } from "@/lib/carousel/runnerControl";
import { mediaLlmAvailable, mediaTransport } from "@/lib/mediaLlm";

export const dynamic = "force-dynamic";

/** Что доступно разделу: Claude, Instagram, режим картинок, ограничения. Значений ключей нет. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  let llm: { available: boolean; transport: string };
  try {
    llm = { available: mediaLlmAvailable(), transport: mediaTransport() };
  } catch (e: any) {
    llm = { available: false, transport: String(e?.message ?? e) };
  }
  const ig = instagramAccountInfo();
  return ok({
    llm,
    instagram: { connected: ig.connected, label: ig.label, via: ig.via, expiresInDays: ig.expiresInDays, problems: ig.problems },
    mode: {
      illustrations: false,
      label: "Текстовые карточки с графическим оформлением",
      note: "Иллюстрации не генерируются: генератор картинок сайта по политике провайдеров закреплён за обложками роликов. Карточки — типографика, цвет и графика шаблона.",
    },
    limits: { slides: { min: CAROUSEL_LIMITS.minSlides, max: CAROUSEL_LIMITS.maxSlides, default: CAROUSEL_LIMITS.defaultSlides }, ig: IG_LIMITS },
    runner: runnerState(),
  });
}
