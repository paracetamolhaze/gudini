import { z } from "zod";
import { llm, type LlmRefs, type LlmRouter } from "../../llm/index.js";
import { REPLY_SYSTEM_PROMPT } from "./prompts.js";
import { extractNumbers } from "../writer/validate.js";
import { CRYPTO_REPLY_POLICY } from "./policy.js";

/** Short, specific, in-voice replies; validated against templates, length, hype and stray numbers. */
export const replyTextSchema = z.object({
  text: z.string().min(2).max(600),
  askedQuestion: z.boolean(),
  confidence: z.number().min(0).max(100),
});

export interface ReplyWriterContext {
  ourPost: string;
  ourFactsText?: string;
  comment: string;
  commenter: string;
  chain: Array<{ username: string; text: string; isOurs: boolean }>;
  kind: "reply" | "mention" | "public";
  wantQuestion: boolean;
  styleExamples?: string[];
  refs?: LlmRefs;
  router?: LlmRouter;
  promptOverride?: { prompt: string; label: string };
}

export interface ReplyViolation {
  code: "TEMPLATE_OPENER" | "TOO_LONG" | "EMPTY" | "HYPE" | "MEANINGLESS" | "STRAY_NUMBER" | "NOT_RUSSIAN" | "FINANCIAL_ADVICE";
  message: string;
  severity: "block" | "warn";
}

const TEMPLATES = /^(отличн(ый|ая|ое) (вопрос|мнение|замечание)|интересн(ое|ый|ая) (мнение|вопрос|мысль)|полностью согласен|спасибо за (вопрос|комментарий)|хороший вопрос|great question|thanks for)/iu;
const MEANINGLESS = /^(🔥+|согласен[.!]*|точно[.!]*|100%[.!]*|факт[.!]*|база[.!]*|\+1|да[.!]*|это точно[.!]*)$/iu;
const HYPE = /(покупа(ем|й|йте)|100x|иксы|гарантирован|точно (полетит|вырастет)|to the moon|туземун)/iu;
const ADVICE = /(советую (купить|продать|зайти|выйти)|бери(те)? (сейчас|пока)|заходи(те)? (сейчас|пока)|фиксируй(те)?|шорти(те)?|лонгуй(те)?)/iu;

export function validateReply(text: string, context: { ourPost: string; ourFactsText?: string; maxChars?: number }): ReplyViolation[] {
  const v: ReplyViolation[] = [];
  const t = text.trim();
  const max = context.maxChars ?? 300;
  if (!t) return [{ code: "EMPTY", message: "пустой ответ", severity: "block" }];
  if (t.length > max) v.push({ code: "TOO_LONG", message: `длина ${t.length} > ${max}`, severity: t.length > max * 1.7 ? "block" : "warn" });
  if (TEMPLATES.test(t)) v.push({ code: "TEMPLATE_OPENER", message: "шаблонное начало (support-bot)", severity: "block" });
  if (MEANINGLESS.test(t)) v.push({ code: "MEANINGLESS", message: "бессодержательный ответ", severity: "block" });
  if (HYPE.test(t)) v.push({ code: "HYPE", message: "хайп/призыв к сделке", severity: "block" });
  if (ADVICE.test(t)) v.push({ code: "FINANCIAL_ADVICE", message: "похоже на финансовый совет", severity: "block" });
  const cyr = (t.match(/[а-яё]/giu) ?? []).length;
  const lat = (t.match(/[a-z]/giu) ?? []).length;
  if (cyr < 5 || cyr < lat) v.push({ code: "NOT_RUSSIAN", message: "ответ не на русском", severity: "block" });
  // Numbers in a reply must already exist in our post or facts — a reply is not the place to introduce data.
  const allowed = extractNumbers(`${context.ourPost}\n${context.ourFactsText ?? ""}`).map((n) => n.value);
  for (const n of extractNumbers(t)) {
    if (n.unit === "count" && Number.isInteger(n.value) && n.value <= 31) continue;
    if (n.unit === "count" && n.value >= 1990 && n.value <= 2100) continue;
    if (!allowed.some((a) => Math.abs(a - n.value) <= Math.max(Math.abs(a) * 0.015, 0.005))) v.push({ code: "STRAY_NUMBER", message: `число «${n.raw}» не из нашего поста`, severity: "warn" });
  }
  return v;
}

export async function writeReply(ctx: ReplyWriterContext): Promise<{ text: string; askedQuestion: boolean; confidence: number; violations: ReplyViolation[]; model: string; promptVersion: string }> {
  const router = ctx.router ?? llm();
  const chain = ctx.chain.length ? ctx.chain.map((m) => `${m.isOurs ? "МЫ" : `@${m.username}`}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n") : "(нет)";
  const kindLine =
    ctx.kind === "public"
      ? "Это чужой публичный пост: мы заходим в разговор как сторонний участник и должны что-то добавить по существу (факт из нашего поста/контекста, уточнение, полезный вопрос). Никаких «согласен», «🔥», «100%»."
      : ctx.kind === "mention"
        ? "Нас упомянули в чужом посте: ответь по существу упоминания."
        : "Комментарий под нашим постом: ответь конкретно на то, что написал человек, учитывая цепочку.";
  const user = `${kindLine}
${ctx.wantQuestion ? "Закончи уместным встречным вопросом, чтобы развить разговор." : "Не задавай вопрос, если он не нужен."}

НАШ ПОСТ / КОНТЕКСТ:
${ctx.ourPost.slice(0, 1200)}
${ctx.ourFactsText ? `\nФАКТЫ, на которые можно опираться (числа только отсюда):\n${ctx.ourFactsText.slice(0, 1200)}` : ""}
${ctx.styleExamples?.length ? `\nПРИМЕРЫ ГОЛОСА:\n${ctx.styleExamples.slice(0, 3).map((s) => `- ${s.slice(0, 200)}`).join("\n")}` : ""}

<untrusted_source_content>
ЦЕПОЧКА:
${chain}

КОММЕНТАРИЙ от @${ctx.commenter}:
${ctx.comment.slice(0, 1500)}
</untrusted_source_content>

Напиши ответ (1–3 предложения, до 300 символов) и верни JSON.`;
  const { data, response } = await router.structured({
    task: "reply",
    operation: ctx.kind === "public" ? "engagement:write" : "reply:write",
    schema: replyTextSchema,
    schemaName: "ReplyText",
    system: `${ctx.promptOverride?.prompt ?? REPLY_SYSTEM_PROMPT}\n${CRYPTO_REPLY_POLICY}`,
    messages: [{ role: "user", content: user }],
    maxTokens: 600,
    temperature: 0.6,
    refs: ctx.refs,
  });
  const text = data.text.trim();
  return { text, askedQuestion: data.askedQuestion, confidence: data.confidence, violations: validateReply(text, { ourPost: ctx.ourPost, ourFactsText: ctx.ourFactsText }), model: `${response.provider}:${response.model}`, promptVersion: ctx.promptOverride?.label ?? "reply_writer_builtin" };
}
