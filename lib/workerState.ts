import fs from "fs";
import path from "path";

/**
 * Состояние внешнего воркера монтажа (ПК владельца).
 * Отметка хранится в файле: разные маршруты Next собираются в отдельные бандлы,
 * поэтому переменная в памяти между ними не разделяется.
 */

export const WORKER_QUEUED_STEP = "В очереди воркера";
export const WORKER_RUNNING_STEP = "Монтаж на воркере";

const STATE_FILE = path.join(process.cwd(), "data", "worker.json");

export function touchWorker() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSeen: Date.now() }));
  } catch {}
}

export function workerActive(): boolean {
  try {
    const { lastSeen } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return Date.now() - lastSeen < 90_000;
  } catch {
    return false;
  }
}
