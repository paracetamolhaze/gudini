import { z } from "zod";
import type { LlmJsonSchema } from "./provider.js";

/**
 * zod schema → JSON schema for providers, and strict parsing of the model's answer back into the
 * zod type. No regex guessing: the text must be a JSON document (optionally fenced) that validates.
 */

export class StructuredOutputError extends Error {
  readonly issues: string[];
  readonly rawText: string;
  constructor(message: string, issues: string[], rawText: string) {
    super(message);
    this.name = "StructuredOutputError";
    this.issues = issues;
    this.rawText = rawText;
  }
}

export function jsonSchemaFor(name: string, schema: z.ZodType): LlmJsonSchema {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return { name, schema: json };
}

/** Strip a ```json fence or leading prose and return the first balanced top-level JSON value. */
export function extractJsonDocument(raw: string): string | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  const startObj = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  const start = startObj < 0 ? startArr : startArr < 0 ? startObj : Math.min(startObj, startArr);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === close) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

export function parseStructured<T>(schema: z.ZodType<T>, raw: string): T {
  const doc = extractJsonDocument(raw);
  if (!doc) throw new StructuredOutputError("model output contained no JSON document", ["no JSON found"], raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc);
  } catch (err) {
    throw new StructuredOutputError(`model output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, ["invalid JSON"], raw);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new StructuredOutputError(`model output failed schema validation: ${issues.slice(0, 5).join("; ")}`, issues, raw);
  }
  return result.data;
}
