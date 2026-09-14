import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

/**
 * One connection pool per process. Timestamps come back as JS Dates; numeric columns are parsed
 * to numbers (scores, costs) — they never exceed double precision in this schema.
 */
pg.types.setTypeParser(1700, (v: string) => Number(v));
pg.types.setTypeParser(20, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });
    pool.on("error", (err) => {
      // A dropped idle client must not crash the process; the next query reconnects.
      console.error("[db] idle client error", err.message);
    });
  }
  return pool;
}

export function setPoolForTests(next: pg.Pool | null): void {
  pool = next;
}

export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = getPool(),
): Promise<T[]> {
  const res = await client.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = getPool(),
): Promise<T | null> {
  const rows = await query<T>(text, params, client);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the original error is the one worth reporting
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
