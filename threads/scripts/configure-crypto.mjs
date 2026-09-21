// Run inside the Threads container after deployment; contains no credentials.
import { saveSettings } from '../dist/src/config/settings.js';
import { listSources, insertSource } from '../dist/src/db/repos/sources.js';
import { closePool } from '../dist/src/db/pool.js';
const model = process.env.LLM_MODEL_WRITER;
if (!model || !process.env.OPENROUTER_API_KEY) throw new Error('Configure the LLM environment first');
await saveSettings({ mode: 'AUTO', killSwitch: false, dryRun: false,
  flags: { autoPost: false, autoOwnReplies: true, autoPublicReplies: true, imageTranslation: false },
  models: { writer: model, analysis: model, reply: model, vision: model, translation: model, embedding: '' },
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
