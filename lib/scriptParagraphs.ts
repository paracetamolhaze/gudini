/**
 * Абзацы для телесуфлёра. Промпт просит абзацы, но модель иногда возвращает сплошной текст:
 * сценарий «Биткоин за минуту» пришёл одним куском из 153 слов, и автору негде было держать паузы.
 * Сплошной текст делится по две фразы, призыв к подписке — отдельным абзацем.
 */
export function ensureParagraphs(script: string): string {
  const text = script.trim();
  if (text.includes("\n")) return text;
  const sentences = (text.match(/[^.!?…]+(?:[.!?…]+[»"”)]*|$)/g) ?? []).map((s) => s.trim()).filter(Boolean);
  // Если разбиение хоть что-то потеряло или фраз мало, текст остаётся как есть.
  const same = (a: string) => a.replace(/\s+/g, " ").trim();
  if (sentences.length < 4 || same(sentences.join(" ")) !== same(text)) return text;
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const sentence of sentences) {
    const cta = /^Подпис/i.test(sentence);
    if (cta && current.length) { paragraphs.push(current); current = []; }
    current.push(sentence);
    if (!cta && current.length === 2) { paragraphs.push(current); current = []; }
  }
  if (current.length) paragraphs.push(current);
  return paragraphs.map((p) => p.join(" ")).join("\n\n");
}
