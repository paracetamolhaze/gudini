#!/usr/bin/env node
/**
 * Безопасное добавление переменных раздела «Карусели» в .env сайта.
 *
 *   node scripts/carousel-env.mjs set CAROUSEL_OPENROUTER_API_KEY   # значение спросит скрыто, в аргументах не передаётся
 *   node scripts/carousel-env.mjs set CAROUSEL_IMAGE_MODEL google/gemini-3.1-flash-image
 *   node scripts/carousel-env.mjs status                              # какие переменные заданы (без значений)
 *
 * Меняется только одна строка: остальные строки .env переписываются как есть, резервная копия
 * .env.bak делается перед записью. Значения никуда не печатаются. Разрешены только переменные
 * CAROUSEL_*. После изменения перезапустите сайт: docker compose up -d --no-deps gudini-site
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_FILE = path.resolve(process.cwd(), ".env");
const ALLOWED = /^CAROUSEL_[A-Z0-9_]+$/;
const [cmd, name, ...rest] = process.argv.slice(2);

function readLines() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
}

async function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput;
    rl.question(prompt, (answer) => {
      rl._writeToOutput = orig;
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) orig.call(rl, prompt);
    };
  });
}

if (cmd === "status") {
  const set = new Set(readLines().map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter((m) => m && m[2].trim()).map((m) => m[1]));
  for (const key of ["CAROUSEL_OPENROUTER_API_KEY", "CAROUSEL_TEXT_MODEL", "CAROUSEL_IMAGE_MODEL", "CAROUSEL_IMAGE_RESOLUTION", "CAROUSEL_MONTHLY_BUDGET_USD", "CAROUSEL_MAX_COST_PER_CAROUSEL_USD", "CAROUSEL_SCHEDULE_GRACE_MINUTES"]) {
    console.log(`${key}: ${set.has(key) ? "задан" : "не задан"}`);
  }
  process.exit(0);
}

if (cmd !== "set" || !name || !ALLOWED.test(name)) {
  console.error("Использование: node scripts/carousel-env.mjs set CAROUSEL_<ИМЯ> [значение] | status");
  process.exit(2);
}

const value = rest.length ? rest.join(" ").trim() : await askHidden(`${name} (ввод скрыт): `);
if (!value) {
  console.error("Пустое значение — ничего не записано");
  process.exit(2);
}
if (/[\r\n]/.test(value)) {
  console.error("Значение не может содержать перевод строки");
  process.exit(2);
}

const lines = readLines();
const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
const line = `${name}=${value}`;
if (idx >= 0) lines[idx] = line;
else {
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  lines.push(line);
}
if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, `${ENV_FILE}.bak`);
fs.writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
console.log(`${name}: ${idx >= 0 ? "обновлён" : "добавлен"} в .env (резервная копия .env.bak). Перезапустите сайт: docker compose up -d --no-deps gudini-site`);
