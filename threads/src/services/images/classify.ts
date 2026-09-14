import type { OcrBlock, PlacedBlock } from "./schemas.js";

/**
 * Which blocks get translated. Deterministic rules on top of the model's role guess:
 * logos, brands, tickers, URLs, watermarks, handles, addresses, hashes and tiny UI text stay.
 */
const KEEP_ROLES = new Set(["ticker", "url", "brand", "watermark", "username", "ui"]);
const TICKER = /^[$#]?[A-Z]{2,6}(?:\/[A-Z]{2,6})?$/;
const URLISH = /(https?:\/\/|www\.|\.(com|io|net|org|xyz|app|finance|exchange)\b)/i;
const HANDLE = /^@[\w.]{2,}$/;
const ADDRESS = /^(0x[0-9a-fA-F]{6,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{20,})$/;
const HASHLIKE = /^[0-9a-fA-F]{16,}$/;
const NUMERIC_ONLY = /^[\s$€£₽+\-−–%.,:0-9kKmMbBxX/]+$/;

export function classifyBlocks(blocks: OcrBlock[], opts: { minHeightGrid?: number; sourceLanguage?: string } = {}): PlacedBlock[] {
  const minH = opts.minHeightGrid ?? 14; // ~1.4% of image height
  return blocks.map((b) => {
    const text = b.text.trim();
    const place: PlacedBlock = { ...b, translate: true };
    const skip = (reason: string) => {
      place.translate = false;
      place.skipReason = reason;
      return place;
    };
    if (KEEP_ROLES.has(b.role)) return skip(`role ${b.role}`);
    if (TICKER.test(text)) return skip("ticker");
    if (URLISH.test(text)) return skip("url");
    if (HANDLE.test(text)) return skip("username");
    if (ADDRESS.test(text) || HASHLIKE.test(text)) return skip("address/hash");
    if (NUMERIC_ONLY.test(text)) return skip("numeric only");
    if (b.language === "ru") return skip("already russian");
    if (b.bbox.h < minH && b.role !== "headline") return skip("too small");
    if (b.confidence < 0.4) return skip("low confidence");
    if (text.length < 2) return skip("too short");
    return place;
  });
}
