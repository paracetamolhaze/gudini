import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { env } from "../../config/env.js";
import { errorMessage } from "../../shared/logger.js";
import { getPool } from "../pool.js";

/**
 * Database dump, taken by the service itself once a day. The Postgres volume is the only copy of
 * everything this account knows — publications, drafts, trades, the voice library, prompt versions —
 * and `scripts/backup.mjs` only runs when the owner remembers it, which he does not.
 *
 * The dump is `pg_dump` from the app image (major 17, to match the server) streamed through gzip
 * into DATA_DIR/backups, i.e. the threads-data volume. Nothing is shelled into another container:
 * the worker has no docker socket. File names, flags and format match the manual script exactly, so
 * `node scripts/backup.mjs --restore <file>` takes either one.
 */

/** Same shape the manual script writes; the name sorts lexicographically, i.e. chronologically. */
const FILE_RE = /^threads-\d{8}-\d{4}\.sql\.gz$/;
/** A dump in progress. It only gets its real name once pg_dump has exited 0 and the file looks sane. */
const PART = ".part";
/** Session advisory lock: app, worker and a second worker share the database and must not dump at once. */
const LOCK_KEY = 84_261_017;
/**
 * This database dumps in seconds; five minutes means pg_dump is wedged. Well under the worker's
 * 10-minute job lock, so a stuck dump fails as a job instead of being declared stalled and retried
 * next to itself.
 */
const TIMEOUT_MS = 5 * 60_000;
/** The schema alone compresses to several KB, so anything below this is not a dump. */
const MIN_BYTES = 1024;

export interface BackupOptions {
  /** How many dumps stay on the volume. */
  keep: number;
  /** Do not dump when the volume has less free space than this. */
  minFreeMb: number;
}

export interface BackupResult {
  /** Name of the new dump, null when the run was skipped. */
  file: string | null;
  bytes: number;
  /** Old dumps deleted to honour `keep`. */
  removed: string[];
  /** Free space on the volume before the dump, MB (null when the platform will not say). */
  freeMb: number | null;
  ms: number;
  /** Set when nothing was dumped because another dump is still running. */
  skipped?: "busy";
}

function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * pg_dump takes the connection from PG* variables instead of a URL on the command line: a URL would
 * put the password into `ps` inside the container and into any crash report.
 */
function connectionEnv(): NodeJS.ProcessEnv {
  let url: URL;
  try {
    url = new URL(env().DATABASE_URL);
  } catch {
    throw new Error("Бэкап не сделан: DATABASE_URL не разобрать");
  }
  const vars: NodeJS.ProcessEnv = {
    PGHOST: decodeURIComponent(url.hostname),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) vars.PGSSLMODE = sslmode;
  return vars;
}

/** Free space on the volume, MB. */
async function freeMb(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** Drop everything past the newest `keep` dumps. Returns what went. */
async function pruneOldDumps(dir: string, keep: number): Promise<string[]> {
  const names = (await readdir(dir))
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const name of names.slice(Math.max(1, Math.trunc(keep)))) {
    await rm(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

async function runPgDump(target: string): Promise<void> {
  // --clean --if-exists for the same reason as the manual script: both containers run migrations on
  // start, so a restore always lands in a database that already has the schema.
  const child = spawn("pg_dump", ["--no-owner", "--no-privileges", "--clean", "--if-exists"], {
    env: { ...process.env, ...connectionEnv() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The kill timer is ours, not spawn's own `timeout` option: node clears that one on the child's
  // `exit` event, and a child that never started (no pg_dump in the image) never emits one — the
  // timer would stay armed and hold the worker's event loop for five minutes after the job failed.
  const killer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const failed: { spawn?: Error } = {};
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-1000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (err: Error) => {
      failed.spawn = err;
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`pg_dump убит (${signal}): дамп не уложился в ${TIMEOUT_MS / 60_000} минут`));
      else if (code !== 0) reject(new Error(`pg_dump вышел с кодом ${code}: ${stderr.trim() || "без сообщения"}`));
      else resolve();
    });
  });
  try {
    // Streamed, not buffered: the dump must not sit in the worker's heap next to sharp and the queues.
    await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(target)), exited]);
  } catch (err) {
    if (failed.spawn) throw new Error(`pg_dump не запускается (${errorMessage(failed.spawn)}): в образе нет клиента Postgres`);
    throw err;
  } finally {
    clearTimeout(killer);
  }
}

/** Dump into `part`, check that it looks like a dump, then move it onto its final name. */
async function writeDump(part: string, target: string): Promise<number> {
  try {
    await runPgDump(part);
    const { size } = await stat(part);
    if (size < MIN_BYTES) throw new Error(`pg_dump записал всего ${size} байт — это не дамп`);
    await rename(part, target);
    return size;
  } catch (err) {
    // Half a dump is worse than none: it takes up space and looks like a backup from the outside.
    await rm(part, { force: true });
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOSPC") {
      throw new Error("Бэкап не дописан: на томе кончилось место, свежей копии базы нет");
    }
    throw err;
  }
}

/**
 * One backup run. Throws when no dump was written — the worker registry turns that into a failed job
 * and a red JOB_FAILED line on the Logs screen, which is the only way the owner learns that the
 * database is unprotected. A successful run is quiet: its result lands in the `jobs` table.
 */
export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const started = Date.now();
  const dir = path.resolve(env().DATA_DIR, "backups");
  await mkdir(dir, { recursive: true });
  const client = await getPool().connect();
  let stillLocked: Error | null = null;
  try {
    const got = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    // Never wait for the other dump: two pg_dumps at once only eat disk, and the next run is tomorrow.
    if (got.rows[0]?.ok !== true) {
      return { file: null, bytes: 0, removed: [], freeMb: await freeMb(dir), ms: Date.now() - started, skipped: "busy" };
    }
    try {
      // Leftovers from a run that was killed mid-dump: while we hold the lock nothing else writes *.part.
      for (const name of await readdir(dir)) if (name.endsWith(PART)) await rm(path.join(dir, name), { force: true });
      // Prune before the dump too: it frees space when `keep` was lowered. The new dump's own rotation
      // happens only after it succeeds, so a failed run never costs the owner an old copy.
      const removed = await pruneOldDumps(dir, opts.keep);

      const free = await freeMb(dir);
      if (free !== null && free < opts.minFreeMb) {
        throw new Error(`Бэкап не сделан: на диске свободно ${free} МБ, нужно хотя бы ${opts.minFreeMb} МБ. Освободите место — база без свежей копии.`);
      }

      const file = `threads-${stamp(new Date())}.sql.gz`;
      const bytes = await writeDump(path.join(dir, `${file}${PART}`), path.join(dir, file));
      removed.push(...(await pruneOldDumps(dir, opts.keep)));
      return { file, bytes, removed, freeMb: free, ms: Date.now() - started };
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      } catch (err) {
        stillLocked = err instanceof Error ? err : new Error(String(err));
      }
    }
  } finally {
    // A client that failed to unlock must not go back into the pool holding the lock, or every later
    // run would see "busy" forever: released with an error it is destroyed, and Postgres drops the
    // lock with the connection.
    client.release(stillLocked ?? undefined);
  }
}
