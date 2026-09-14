import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, one } from "../../db/pool.js";
import { HttpError } from "../server.js";
import { threadsClient } from "../../threads/index.js";
import { activatePromptVersion, createPromptVersion, listPromptVersions, getActivePrompt } from "../../services/promptVersions.js";
import { WRITER_PROMPT_NAME, WRITER_SYSTEM_PROMPT } from "../../services/writer/prompts.js";
import { ANALYZER_SYSTEM_PROMPT, ANALYZER_PROMPT_NAME } from "../../services/analysis/analyzer.js";
import { REPLY_PROMPT_NAME, REPLY_SYSTEM_PROMPT, REPLY_DECISION_PROMPT_NAME, REPLY_DECISION_SYSTEM_PROMPT } from "../../services/replies/prompts.js";
import { errorMessage } from "../../shared/logger.js";

/** VOICE (style examples) and PROMPTS (versioned system prompts). */
export function registerVoiceRoutes(app: FastifyInstance, api: string): void {
  app.get(`${api}/voice/examples`, async () => ({ examples: await query(`SELECT * FROM style_examples ORDER BY created_at DESC LIMIT 500`) }));

  const exampleBody = z.object({ text: z.string().trim().min(10).max(2000), rating: z.number().int().min(1).max(5).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(10).optional() });
  app.post(`${api}/voice/examples`, async (req, reply) => {
    const parsed = exampleBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
    const row = await one(`INSERT INTO style_examples (text, rating, source, enabled, tags) VALUES ($1,$2,'manual',true,$3) RETURNING *`, [parsed.data.text, parsed.data.rating ?? 4, parsed.data.tags ?? []]);
    return reply.code(201).send({ example: row });
  });

  app.patch(`${api}/voice/examples/:id`, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean().optional(), rating: z.number().int().min(1).max(5).optional(), tags: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, "invalid patch");
    const row = await one(
      `UPDATE style_examples SET enabled = COALESCE($2, enabled), rating = COALESCE($3, rating), tags = COALESCE($4, tags) WHERE id = $1 RETURNING *`,
      [id, body.data.enabled ?? null, body.data.rating ?? null, body.data.tags ?? null],
    );
    if (!row) throw new HttpError(404, "example not found");
    return { example: row };
  });

  app.delete(`${api}/voice/examples/:id`, async (req) => {
    const { id } = req.params as { id: string };
    await query(`DELETE FROM style_examples WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Import the account's own recent posts as style examples (needs threads_basic). */
  app.post(`${api}/voice/import`, async (req) => {
    const count = Math.max(1, Math.min(50, Number((req.body as { count?: number } | null)?.count ?? 20)));
    const client = threadsClient();
    if (!client.hasToken) throw new HttpError(409, "THREADS_ACCESS_TOKEN is not set");
    try {
      const page = await client.myPosts({ limit: count });
      let imported = 0;
      for (const p of page.data ?? []) {
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (text.length < 20) continue;
        const exists = await one(`SELECT id FROM style_examples WHERE text = $1`, [text]);
        if (exists) continue;
        await query(`INSERT INTO style_examples (text, rating, source, enabled, tags) VALUES ($1, 3, 'threads_import', true, '{}')`, [text]);
        imported++;
      }
      return { imported, fetched: page.data?.length ?? 0 };
    } catch (err) {
      throw new HttpError(502, `Threads: ${errorMessage(err)}`);
    }
  });

  // ---- prompts ---------------------------------------------------------------------------
  const BUILT_INS: Record<string, string> = {
    [WRITER_PROMPT_NAME]: WRITER_SYSTEM_PROMPT,
    [ANALYZER_PROMPT_NAME]: ANALYZER_SYSTEM_PROMPT,
    [REPLY_PROMPT_NAME]: REPLY_SYSTEM_PROMPT,
    [REPLY_DECISION_PROMPT_NAME]: REPLY_DECISION_SYSTEM_PROMPT,
  };

  app.get(`${api}/prompts`, async () => {
    for (const [name, builtIn] of Object.entries(BUILT_INS)) await getActivePrompt(name, builtIn);
    return { prompts: await listPromptVersions(), names: Object.keys(BUILT_INS) };
  });

  const promptBody = z.object({ name: z.string().min(1).max(60), prompt: z.string().min(20).max(20000), note: z.string().max(300).optional() });
  app.post(`${api}/prompts`, async (req, reply) => {
    const parsed = promptBody.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
    if (!(parsed.data.name in BUILT_INS)) throw new HttpError(400, `unknown prompt name; use one of ${Object.keys(BUILT_INS).join(", ")}`);
    const row = await createPromptVersion(parsed.data.name, parsed.data.prompt, parsed.data.note ?? null);
    return reply.code(201).send({ prompt: row });
  });

  app.post(`${api}/prompts/:id/activate`, async (req) => {
    const { id } = req.params as { id: string };
    return { prompt: await activatePromptVersion(id) };
  });
}
