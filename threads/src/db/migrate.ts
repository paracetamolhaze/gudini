import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "./pool.js";
import { logger } from "../shared/logger.js";
import { projectDir } from "../shared/paths.js";

/**
 * Numbered SQL migrations (migrations/NNNN_name.sql), each applied once inside a transaction.
 * A migration that fails leaves the schema untouched and the process exits non-zero.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = projectDir(here, "migrations");

const MIGRATION_LOCK = 727272;

export async function runMigrations(dir = MIGRATIONS_DIR): Promise<string[]> {
  const pool = getPool();
  // app and worker both migrate at boot; the advisory lock serialises them.
  const lock = await pool.connect();
  const done: string[] = [];
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const applied = new Set((await lock.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await lock.query("BEGIN");
        await lock.query(sql);
        await lock.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await lock.query("COMMIT");
        done.push(file);
        logger().info({ migration: file }, "migration applied");
      } catch (err) {
        await lock.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    lock.release();
  }
  return done;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then((done) => {
      logger().info({ count: done.length }, done.length ? "migrations done" : "schema is up to date");
      return closePool();
    })
    .catch((err) => {
      logger().error({ err }, "migration failed");
      process.exit(1);
    });
}
