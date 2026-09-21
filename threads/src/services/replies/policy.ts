/** Shared account policy; enforced in addition to editable voice prompts. */
export const CRYPTO_REPLY_POLICY = `Обсуждай только криптовалюты, блокчейн и непосредственно связанные с ними события.
Если связь с криптой отсутствует, нет содержательного вопроса или нечего добавить — пропускай.
Экспертность — объяснение механизма, ограничений и рисков, а не уверенный прогноз цены.
Не придумывай личный опыт, сделки, доходность, инсайдерские сведения и профессиональные регалии.
Не выдавай слова собеседника и сгенерированный угол ответа за проверенные факты.
Без подтверждённых источников не добавляй свежие новости, цены, статистику и обвинения.
Не рекламируй аккаунт, не зови подписаться, не добавляй ссылки, хэштеги и вопросы ради вовлечения.
Не повторяй исходный пост другими словами. Достаточно одного конкретного полезного уточнения.`;

export type RecentReply = { text: string; username: string; rootId: string | null; public: boolean; at: Date };
export function similarReply(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const x = words(a), y = words(b);
  const overlap = [...x].filter(w => y.has(w)).length;
  return x.size > 0 && overlap / Math.max(x.size, y.size) >= 0.8;
}

export function replyHold(input: { text: string; username: string; rootId: string | null; public: boolean; targetAt: Date | null }, recent: RecentReply[], now = new Date()): { reason: string; permanent: boolean } | null {
  const age = input.targetAt ? now.getTime() - input.targetAt.getTime() : Infinity;
  if (age > (input.public ? 24 : 72) * 3_600_000) return { reason: "Обсуждение устарело или дата неизвестна", permanent: true };
  if (recent.some(r => similarReply(input.text, r.text))) return { reason: "Похожий ответ уже отправляли", permanent: true };
  if (input.public && recent.some(r => r.public && r.username.toLowerCase() === input.username.toLowerCase())) return { reason: "Этому автору уже комментировали за последние сутки", permanent: true };
  if (input.rootId && recent.filter(r => r.rootId === input.rootId && r.username.toLowerCase() === input.username.toLowerCase()).length >= (input.public ? 1 : 2)) return { reason: "Достаточно ответов этому человеку в одной ветке", permanent: true };
  const gap = (input.public ? 30 : 5) * 60_000;
  if (recent.some(r => r.public === input.public && now.getTime() - r.at.getTime() < gap)) return { reason: `Пауза между ответами: ${input.public ? 30 : 5} минут`, permanent: false };
  return null;
}
