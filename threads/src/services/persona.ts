import type { Settings } from "../config/settings.js";

/**
 * Everything the account says is said by its owner, in the first person. The persona block is put
 * in front of every writer/reply prompt; the safety rails of those prompts still apply on top.
 */
export function personaBlock(settings: Pick<Settings, "persona">, opts: { language?: "ru" | "en" } = {}): string {
  const p = settings.persona;
  const who = [p.name.trim(), p.bio.trim()].filter(Boolean).join(". ");
  const lines = [
    "ГОЛОС: ты пишешь от первого лица — как владелец аккаунта, живой человек, а не редакция, не новостной канал и не бот.",
    who ? `Кто ты: ${who}` : "",
    p.tone.trim() ? `Как ты говоришь: ${p.tone.trim()}` : "",
    p.rules.trim() ? `Твои личные правила: ${p.rules.trim()}` : "",
    "- Пиши «я», а не «мы». Никаких «наша редакция», «мы следим за рынком», «подписывайтесь».",
    "- О своих сделках говори только то, что дано в фактах. Не выдумывай сделки, доходность, стаж, инсайды и регалии.",
    "- Личное мнение — это мнение: «мне кажется», «я бы», «на мой взгляд». Не выдавай его за факт и не раздавай советы, что покупать или продавать.",
    opts.language === "en" ? "- LANGUAGE: write this text in natural, casual English (crypto-Twitter register, no corporate tone)." : "",
  ];
  return lines.filter(Boolean).join("\n");
}
