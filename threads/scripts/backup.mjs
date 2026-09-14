#!/usr/bin/env node
/**
 * Postgres backup for the Threads service. Uses pg_dump inside the compose container
 * (gudini-threads-postgres) so nothing has to be installed on the host; keeps the last 14 dumps.
 *
 *   node scripts/backup.mjs            → data/backups/threads-YYYYMMDD-HHMM.sql.gz
 *   node scripts/backup.mjs --restore data/backups/threads-20260914-1200.sql.gz
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, createReadStream, createWriteStream } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const container = process.env.THREADS_PG_CONTAINER || "gudini-threads-postgres";
const dbUser = process.env.THREADS_PG_USER || "threads";
const dbName = process.env.THREADS_PG_DB || "threads";
const dir = path.resolve(process.env.BACKUP_DIR || "data/backups");
const keep = Number(process.env.BACKUP_KEEP || 14);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function backup() {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `threads-${stamp()}.sql.gz`);
  const dump = spawnSync("docker", ["exec", container, "pg_dump", "-U", dbUser, "--no-owner", "--no-privileges", dbName], { maxBuffer: 1024 * 1024 * 1024 });
  if (dump.status !== 0) {
    console.error(dump.stderr.toString());
    process.exit(1);
  }
  const gz = createGzip();
  const out = createWriteStream(file);
  gz.end(dump.stdout);
  await pipeline(gz, out);
  console.log(`backup written: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
  const old = readdirSync(dir)
    .filter((f) => /^threads-\d{8}-\d{4}\.sql\.gz$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    unlinkSync(path.join(dir, f));
    console.log(`removed old backup ${f}`);
  }
}

async function restore(file) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const chunks = [];
  await pipeline(createReadStream(file), createGunzip(), async function* (source) {
    for await (const c of source) chunks.push(c);
  });
  const sql = Buffer.concat(chunks);
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", dbUser, "-d", dbName, "-v", "ON_ERROR_STOP=1"], { input: sql, stdio: ["pipe", "inherit", "inherit"] });
  console.log(`restored ${file} into ${container}/${dbName}`);
}

const args = process.argv.slice(2);
const restoreIdx = args.indexOf("--restore");
(restoreIdx >= 0 ? restore(args[restoreIdx + 1]) : backup()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
