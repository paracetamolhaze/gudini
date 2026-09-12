import os from "os";
import type { CarouselJob } from "./types";
import { acquireRunnerLock, claimJob, findRunnableJob, finishJob, patchJob, releaseRunnerLock, touchRunnerLock } from "./store";
import { executeJob } from "./jobs";
import { settlePublish } from "./publishJob";

/**
 * Фоновый обработчик каруселей — отдельный процесс. Его запускает сайт, когда в очереди
 * есть задания (lib/carousel/runnerControl.ts), и при старте сервера — чтобы продолжить
 * прерванное перезапуском. Вкладка браузера для работы не нужна.
 *
 * Ограничения расхода: один обработчик на весь раздел (файловая блокировка), одно задание
 * за раз, пониженный приоритет процесса, браузер закрывается после каждого задания,
 * без заданий процесс завершается через 45 секунд.
 */

const PID = process.pid;
const IDLE_EXIT_MS = 45_000;
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();

function giveUp(id: string, job: CarouselJob) {
  const message = "Задание прерывалось несколько раз (перезапуск или сбой обработчика) и остановлено. Запустите его снова.";
  try {
    if (job.type === "publish" || job.type === "verify_publish") settlePublish(id, "Публикация прерывалась несколько раз и остановлена.");
    finishJob(id, job.id, "error", { error: message });
  } catch {}
}

async function main() {
  try {
    os.setPriority(0, 10);
  } catch {}
  if (!acquireRunnerLock(PID)) {
    console.log(`${stamp()} обработчик каруселей уже работает — выхожу`);
    return;
  }
  console.log(`${stamp()} обработчик каруселей запущен, pid ${PID}`);
  const lockBeat = setInterval(() => {
    try {
      if (!touchRunnerLock(PID)) {
        console.error(`${stamp()} блокировку обработчика занял другой процесс — выхожу`);
        process.exit(0);
      }
    } catch {}
  }, 5000);

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  let idleSince = Date.now();
  try {
    while (!stopping) {
      const next = findRunnableJob();
      if (!next) {
        if (Date.now() - idleSince > IDLE_EXIT_MS) break;
        await sleep(1500);
        continue;
      }
      const claimed = claimJob(next.carouselId, next.jobId, PID);
      if (!claimed) {
        await sleep(300);
        continue;
      }
      const job = claimed.carousel.job!;
      if (job.attempts > MAX_ATTEMPTS) {
        console.log(`${stamp()} ${job.type} ${next.carouselId}: попыток ${job.attempts - 1}, остановлено`);
        giveUp(next.carouselId, job);
        idleSince = Date.now();
        continue;
      }
      console.log(`${stamp()} ${job.type} ${next.carouselId}${claimed.resumed ? " — продолжение прерванного" : ""}`);
      const beat = setInterval(() => {
        try {
          patchJob(next.carouselId, job.id, {});
        } catch {}
      }, 5000);
      try {
        await executeJob(next.carouselId, job);
      } catch (e: any) {
        console.error(`${stamp()} задание упало: ${String(e?.message ?? e).slice(0, 300)}`);
      } finally {
        clearInterval(beat);
      }
      console.log(`${stamp()} ${job.type} ${next.carouselId} завершено`);
      idleSince = Date.now();
    }
  } finally {
    clearInterval(lockBeat);
    releaseRunnerLock(PID);
    console.log(`${stamp()} обработчик каруселей остановлен`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`${stamp()} обработчик каруселей упал: ${String(e?.stack ?? e).slice(0, 800)}`);
    releaseRunnerLock(PID);
    process.exit(1);
  },
);
