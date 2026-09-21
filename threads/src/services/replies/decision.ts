import { z } from "zod";
import { llm, type LlmRefs, type LlmRouter } from "../../llm/index.js";
import { REPLY_DECISION_SYSTEM_PROMPT } from "./prompts.js";
import { CRYPTO_REPLY_POLICY } from "./policy.js";
import { sanitizeUntrusted } from "../../shared/untrusted.js";

/**
 * Should we answer this comment? Cheap deterministic rules first (emoji-only, "+", scam links,
 * repeats), then the structured decision from the reply model.
 */
export const replyDecisionSchema = z.object({
  action: z.enum(["SKIP", "REPLY", "REPLY_AND_QUESTION", "NEEDS_REVIEW"]),
  reason: z.string().min(2).max(300),
  sentiment: z.enum(["positive", "neutral", "negative", "spam"]),
  toxicityScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
});
export type ReplyDecision = z.infer<typeof replyDecisionSchema>;

export interface DecisionContext {
  ourPost: string;
  comment: string;
  commenter: string;
  chain: Array<{ username: string; text: string; isOurs: boolean }>;
  /** Earlier comments by the same person in this thread (repeat detection). */
  priorFromSameUser: string[];
  kind: "reply" | "mention" | "public";
  refs?: LlmRefs;
  router?: LlmRouter;
  promptOverride?: string;
}

const SCAM = /(airdrop|giveaway|dm me|write me|whatsapp|telegram\.me|t\.me\/|referral|промокод|раздача|розыгрыш|пиши в лс|сид[- ]?фраз|seed phrase|private key|приватн(ый|ого) ключ|wallet connect|claim your|free \$?\d)/iu;
const BAIT = /(скам|scam|лохи|дно|мусор|шляпа|rug)\W*$/iu;

export function ruleDecision(ctx: DecisionContext): ReplyDecision | null {
  const text = ctx.comment.trim();
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (!text || letters === 0) return { action: "SKIP", reason: "только emoji, символы или пусто", sentiment: "neutral", toxicityScore: 0, confidence: 99 };
  if (/^[+.\-!?\s]+$/.test(text) || /^(первый|first|\+1|плюс|топ|ок|ok|лол|lol|кек|ага|да|нет)[.!]*$/iu.test(text)) return { action: "SKIP", reason: "бессодержательная реплика", sentiment: "neutral", toxicityScore: 0, confidence: 97 };
  if (SCAM.test(text) || /https?:\/\/\S+/i.test(text) && letters < 40) return { action: "SKIP", reason: "похоже на спам или скам-ссылку", sentiment: "spam", toxicityScore: 60, confidence: 95 };
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (ctx.priorFromSameUser.some((p) => norm(p) === norm(text))) return { action: "SKIP", reason: "повтор того же комментария от того же пользователя", sentiment: "neutral", toxicityScore: 10, confidence: 95 };
  if (letters < 4 && !/\?/.test(text)) return { action: "SKIP", reason: "слишком коротко, нечего отвечать", sentiment: "neutral", toxicityScore: 0, confidence: 90 };
  if (BAIT.test(text) && letters < 25) return { action: "SKIP", reason: "агрессивный bait без аргумента", sentiment: "negative", toxicityScore: 55, confidence: 85 };
  return null;
}

export async function decideReply(ctx: DecisionContext): Promise<{ decision: ReplyDecision; source: "rules" | "model"; model?: string }> {
  const byRule = ruleDecision(ctx);
  if (byRule) return { decision: byRule, source: "rules" };
  const router = ctx.router ?? llm();
  const chain = ctx.chain.length
    ? ctx.chain.map((m) => `${m.isOurs ? "МЫ" : `@${sanitizeUntrusted(m.username)}`}: ${sanitizeUntrusted(m.text).replace(/\s+/g, " ").slice(0, 400)}`).join("\n")
    : "(нет предыдущих реплик)";
  const user = `Тип: ${ctx.kind === "mention" ? "нас упомянули в чужом посте" : ctx.kind === "public" ? "чужой публичный пост, мы решаем, стоит ли отвечать" : "комментарий под нашим постом"}
НАШ ПОСТ:
${ctx.ourPost.slice(0, 1200)}

<untrusted_source_content>
ЦЕПОЧКА:
${chain}

НОВЫЙ КОММЕНТАРИЙ от @${sanitizeUntrusted(ctx.commenter)}:
${sanitizeUntrusted(ctx.comment).slice(0, 1500)}
</untrusted_source_content>

Верни JSON-решение.`;
  const { data, response } = await router.structured({
    task: "reply",
    operation: "reply:decision",
    schema: replyDecisionSchema,
    schemaName: "ReplyDecision",
    system: `${ctx.promptOverride ?? REPLY_DECISION_SYSTEM_PROMPT}\n${CRYPTO_REPLY_POLICY}`,
    messages: [{ role: "user", content: user }],
    maxTokens: 500,
    temperature: 0.1,
    refs: ctx.refs,
  });
  return { decision: data, source: "model", model: `${response.provider}:${response.model}` };
}
