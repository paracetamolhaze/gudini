// Run inside the Threads container after deployment; contains no credentials.
import { saveSettings } from '../dist/src/config/settings.js';
import { listSources, insertSource } from '../dist/src/db/repos/sources.js';
import { closePool } from '../dist/src/db/pool.js';
// The normal setup writes texts through the local Claude bridge; a paid provider key is the fallback.
const bridge = Boolean(process.env.CLAUDE_BRIDGE_URL && process.env.CLAUDE_BRIDGE_TOKEN);
const paidKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY
  || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY;
if (!bridge && !paidKey) {
  throw new Error('Сначала настройте LLM в threads/.env: либо мост к Claude (CLAUDE_BRIDGE_URL и CLAUDE_BRIDGE_TOKEN), либо ключ платного провайдера (например OPENROUTER_API_KEY).');
}
// Models are touched only when LLM_MODEL_WRITER is set explicitly: otherwise the working setup stays.
const model = process.env.LLM_MODEL_WRITER;
await saveSettings({ mode: 'AUTO', killSwitch: false, dryRun: false,
  flags: { autoPost: false, autoOwnReplies: true, autoPublicReplies: true, imageTranslation: false },
  ...(model ? { models: { writer: model, analysis: model, reply: model, vision: model, translation: model, embedding: '' } } : {}),
  limits: { maxPublicRepliesPerHour: 2, maxPublicRepliesPerDay: 6, maxOwnRepliesPerHour: 6, maxOwnRepliesPerDay: 30 },
  engagement: { minimumScore: 80, pollMinutes: 30 }, replies: { minConfidence: 85 },
});
const existing = await listSources();
for (const source of [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', trust_score: 75 },
  { name: 'Ethereum Blog', url: 'https://blog.ethereum.org/feed.xml', trust_score: 90 },
]) {
  if (!existing.some(s => s.url === source.url)) await insertSource({ type: 'RSS', language: 'en', poll_minutes: 60, ...source });
}
console.log('Crypto profile configured: posts need approval; replies automatic with limits.');
await closePool();
