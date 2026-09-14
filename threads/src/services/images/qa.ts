import type { ImageQaResult, OcrResult, PlacedBlock } from "./schemas.js";

/**
 * Quality gate on the final image, given a second OCR pass: Russian text is present, the
 * translated English is gone, required numbers survived, nothing overflowed its box.
 */
export function evaluateImageQa(blocks: PlacedBlock[], finalOcr: OcrResult, opts: { minCyrillicRatio?: number } = {}): ImageQaResult {
  const issues: string[] = [];
  const translated = blocks.filter((b) => b.translate && b.translation);
  const finalText = finalOcr.blocks.map((b) => b.text).join("\n");
  const letters = finalText.match(/\p{L}/gu) ?? [];
  const cyr = finalText.match(/[а-яё]/giu) ?? [];
  const cyrillicRatio = letters.length ? cyr.length / letters.length : 0;
  if (translated.length && cyr.length === 0) issues.push("на итоговой картинке не распознан русский текст");

  const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").trim();
  const finalNorm = norm(finalText);
  const englishLeft: string[] = [];
  for (const b of translated) {
    const orig = norm(b.text);
    if (orig.length >= 6 && /[a-z]{3,}/i.test(orig) && finalNorm.includes(orig)) englishLeft.push(b.text);
  }
  if (englishLeft.length) issues.push(`остался исходный английский текст: ${englishLeft.slice(0, 3).join(" | ")}`);

  const digitsOnly = (s: string) => s.replace(/[^0-9]/g, "");
  const finalDigits = finalText.replace(/[\s,.]/g, "");
  const numbersMissing: string[] = [];
  for (const b of translated) {
    for (const m of b.text.matchAll(/\d[\d,.]*\d|\d/g)) {
      const n = digitsOnly(m[0]);
      if (n && !finalDigits.includes(n)) numbersMissing.push(m[0]);
    }
  }
  if (numbersMissing.length) issues.push(`не сохранились числа: ${[...new Set(numbersMissing)].slice(0, 5).join(", ")}`);

  const overflow = translated.filter((b) => b.rendered?.overflow);
  if (overflow.length) issues.push(`текст не поместился в ${overflow.length} блок(ах): ${overflow.map((b) => b.translation?.slice(0, 30)).join(" | ")}`);

  const minRatio = opts.minCyrillicRatio ?? 0.3;
  if (translated.length && letters.length > 0 && cyrillicRatio < minRatio) issues.push(`доля кириллицы всего ${Math.round(cyrillicRatio * 100)}%`);

  return { passed: issues.length === 0, issues, cyrillicRatio, numbersMissing: [...new Set(numbersMissing)], englishLeft };
}
