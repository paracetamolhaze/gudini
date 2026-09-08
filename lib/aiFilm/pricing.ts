/**
 * Цены Veo на Vertex AI, USD за секунду сгенерированного видео.
 * Источник: cloud.google.com/vertex-ai/generative-ai/pricing, раздел Veo (сверено 2026-09-08).
 * Ручной override — AI_FILM_PRICE_PER_SEC (для любой модели), иначе цена по политике.
 * Неизвестная модель — ошибка: считать план по чужой цене хуже, чем остановиться.
 */

export type VeoResolution = "720p" | "1080p" | "4k";

type PriceRow = { audio: Partial<Record<VeoResolution, number>>; video: Partial<Record<VeoResolution, number>> };

export const VEO_PRICES: Record<string, PriceRow> = {
  "veo-3.1-generate-001": { audio: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 }, video: { "720p": 0.2, "1080p": 0.2, "4k": 0.4 } },
  "veo-3.1-fast-generate-001": { audio: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 }, video: { "720p": 0.08, "1080p": 0.1, "4k": 0.25 } },
  "veo-3.1-lite-generate-001": { audio: { "720p": 0.05, "1080p": 0.08 }, video: { "720p": 0.03, "1080p": 0.05 } },
  "veo-3.0-generate-001": { audio: { "720p": 0.4, "1080p": 0.4 }, video: { "720p": 0.2, "1080p": 0.2 } },
  "veo-3.0-fast-generate-001": { audio: { "720p": 0.1, "1080p": 0.12 }, video: { "720p": 0.08, "1080p": 0.1 } },
};

export function veoPricePerSecond(model: string, opts: { audio: boolean; resolution: VeoResolution }): { pricePerSec: number; source: "policy" | "env" } {
  const override = Number(process.env.AI_FILM_PRICE_PER_SEC);
  if (process.env.AI_FILM_PRICE_PER_SEC && Number.isFinite(override) && override > 0) return { pricePerSec: override, source: "env" };
  const row = VEO_PRICES[model];
  if (!row) throw new Error(`Цена Veo: модель «${model}» не в таблице цен — задайте AI_FILM_PRICE_PER_SEC или добавьте модель в pricing.ts`);
  const table = opts.audio ? row.audio : row.video;
  const price = table[opts.resolution];
  if (price == null) throw new Error(`Цена Veo: у «${model}» нет тарифа за ${opts.resolution} ${opts.audio ? "со звуком" : "без звука"}`);
  return { pricePerSec: price, source: "policy" };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
