import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { carouselsRoot, findRunnableJob, readRunnerLock, RUNNER_STALE_MS } from "./store";

/**
 * Запуск фонового обработчика каруселей из процесса сайта. Обработчик — отдельный процесс
 * (tsx lib/carousel/runner.ts), как воркер монтажа: рендер в Chromium и вызовы Claude не
 * нагружают сервер сайта, у обработчика свой учёт расходов и пониженный приоритет.
 */

const g = globalThis as unknown as { __gudiniCarouselSpawnAt?: number };

export function runnerState(now = Date.now()): { alive: boolean; pid: number | null } {
  const lock = readRunnerLock();
  const alive = Boolean(lock && now - lock.heartbeatAt < RUNNER_STALE_MS);
  return { alive, pid: alive ? lock!.pid : null };
}

export function ensureRunner(): { started: boolean; reason: string } {
  try {
    if (!findRunnableJob()) return { started: false, reason: "заданий нет" };
    if (runnerState().alive) return { started: false, reason: "обработчик работает" };
    if (g.__gudiniCarouselSpawnAt && Date.now() - g.__gudiniCarouselSpawnAt < 15_000) return { started: false, reason: "обработчик запускается" };

    const cwd = process.cwd();
    const cli = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = path.join(cwd, "lib", "carousel", "runner.ts");
    if (!fs.existsSync(cli) || !fs.existsSync(entry)) {
      console.error("Карусели: не найден tsx или lib/carousel/runner.ts — фоновые задания не выполняются");
      return { started: false, reason: "нет обработчика" };
    }

    fs.mkdirSync(carouselsRoot(), { recursive: true });
    const logFile = path.join(carouselsRoot(), "runner.log");
    try {
      if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    } catch {}
    const fd = fs.openSync(logFile, "a");
    g.__gudiniCarouselSpawnAt = Date.now();
    const child = spawn(process.execPath, [cli, entry], {
      cwd,
      env: { ...process.env, CAROUSEL_RUNNER: "1" },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    fs.closeSync(fd);
    child.on("error", (e) => console.error("Карусели: обработчик не запустился:", e.message));
    child.unref();
    if (child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {}
    }
    return { started: true, reason: "запущен" };
  } catch (e: any) {
    console.error("Карусели: запуск обработчика:", String(e?.message ?? e));
    return { started: false, reason: String(e?.message ?? e) };
  }
}

/** При старте сервера: продолжить задания, прерванные перезапуском или развёртыванием. */
export function kickRunnerOnBoot(): void {
  const timer = setTimeout(() => ensureRunner(), 4000);
  timer.unref?.();
}
