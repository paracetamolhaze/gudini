import { one, query } from "../db/pool.js";
import { audit } from "./audit.js";

/**
 * Versioned prompts. Built-in defaults are seeded as version 1 on first use; the dashboard can add
 * new versions and activate one. Every draft/reply records the prompt name+version it was written with.
 */
export interface PromptVersionRow {
  id: string;
  name: string;
  version: number;
  prompt: string;
  active: boolean;
  note: string | null;
  created_at: Date;
}

export interface ActivePrompt {
  name: string;
  version: number;
  prompt: string;
  label: string;
}

const cache = new Map<string, { at: number; value: ActivePrompt }>();
const CACHE_MS = 10_000;

export async function getActivePrompt(name: string, builtIn: string): Promise<ActivePrompt> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let row = await one<PromptVersionRow>(`SELECT * FROM prompt_versions WHERE name = $1 AND active ORDER BY version DESC LIMIT 1`, [name]);
  if (!row) {
    const exists = await one<{ n: number }>(`SELECT count(*)::int AS n FROM prompt_versions WHERE name = $1`, [name]);
    if (!exists || exists.n === 0) {
      row = await one<PromptVersionRow>(`INSERT INTO prompt_versions (name, version, prompt, active, note) VALUES ($1, 1, $2, true, 'built-in default') RETURNING *`, [name, builtIn]);
    }
  }
  const value: ActivePrompt = row
    ? { name, version: row.version, prompt: row.prompt, label: `${name}_v${row.version}` }
    : { name, version: 0, prompt: builtIn, label: `${name}_builtin` };
  cache.set(name, { at: Date.now(), value });
  return value;
}

export async function listPromptVersions(): Promise<PromptVersionRow[]> {
  return query<PromptVersionRow>(`SELECT * FROM prompt_versions ORDER BY name, version DESC`);
}

export async function createPromptVersion(name: string, prompt: string, note: string | null): Promise<PromptVersionRow> {
  const next = await one<{ v: number }>(`SELECT COALESCE(max(version), 0) + 1 AS v FROM prompt_versions WHERE name = $1`, [name]);
  const row = await one<PromptVersionRow>(`INSERT INTO prompt_versions (name, version, prompt, active, note) VALUES ($1,$2,$3,false,$4) RETURNING *`, [name, next?.v ?? 1, prompt, note]);
  if (!row) throw new Error("insert prompt version failed");
  return row;
}

export async function activatePromptVersion(id: string): Promise<PromptVersionRow> {
  const row = await one<PromptVersionRow>(`SELECT * FROM prompt_versions WHERE id = $1`, [id]);
  if (!row) throw new Error("prompt version not found");
  await query(`UPDATE prompt_versions SET active = false WHERE name = $1 AND active`, [row.name]);
  await query(`UPDATE prompt_versions SET active = true WHERE id = $1`, [id]);
  cache.delete(row.name);
  await audit("PROMPT_ACTIVATED", `Активирован промпт ${row.name} v${row.version}`, {}, { name: row.name, version: row.version }, "warn");
  return { ...row, active: true };
}

export function invalidatePromptCache(): void {
  cache.clear();
}
