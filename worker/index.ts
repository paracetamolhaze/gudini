/**
 * Воркер монтажа Гудини — запускается на вашем ПК: `npm run worker`.
 *
 * Опрашивает сайт, забирает задачи монтажа, скачивает исходник,
 * монтирует локально (вся мощность вашего компьютера + ключи из .env)
 * и заливает готовый ролик обратно. Пока воркер запущен, сайт сам
 * ничего не монтирует; выключите — сайт вернётся к серверному монтажу.
 *
 * Настройки в .env: GUDINI_URL, GUDINI_PASSWORD (пароль сайта).
 */

import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { getProject, upsertProject, projectDir, Project, UPLOADS_DIR } from "../lib/store";
import { runFromLedgerFile, SpendRun } from "../lib/spendLog";
import { processProject } from "../lib/pipeline";
import { fileFingerprint } from "../lib/fileFingerprint";

// --- .env ---
try {
  const env = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const SITE = (process.env.GUDINI_URL ?? "https://gudini-production.up.railway.app").replace(/\/$/, "");
const PASSWORD = process.env.GUDINI_PASSWORD ?? process.env.SITE_PASSWORD ?? "";
const AUTH = "Basic " + Buffer.from(`worker:${PASSWORD}`).toString("base64");

async function api(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(SITE + pathname, {
    ...init,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Подтягивает reference-фото и cover-шрифт с сайта; отсутствие — не ошибка. */
async function syncFace(): Promise<void> {
  try {
    const res = await fetch(`${SITE}/api/settings/face`, { headers: { Authorization: AUTH } });
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 1000) {
      fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), "data", "face.jpg"), buffer);
    }
  } catch {}
  try {
    const res = await fetch(`${SITE}/api/settings/coverfont`, { headers: { Authorization: AUTH } });
    if (!res.ok) return;
    const name = res.headers.get("x-font-name") ?? "coverfont.ttf";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 1000) {
      fs.writeFileSync(path.join(process.cwd(), "data", name.endsWith(".otf") ? "coverfont.otf" : "coverfont.ttf"), buffer);
    }
  } catch {}
}

async function downloadRaw(project: Project): Promise<void> {
  const dir = projectDir(project.id);
  const target = path.join(dir, project.rawVideo!);
  const url = `${SITE}/api/projects/${project.id}/video?which=raw`;
  // Исходник на гигабайт нельзя держать в памяти целиком: пишем потоком на диск.
  // Если файл того же размера уже есть (повторная обработка), не качаем заново.
  const head = await fetch(url, { method: "HEAD", headers: { Authorization: AUTH } });
  const expected = Number(head.headers.get("content-length") ?? 0);
  // Совпадение по размеру было единственной проверкой: новый исходник той же длины
  // считался старым. Сайт присылает отпечаток содержимого (ETag) — сверяем по нему.
  const remoteTag = (head.headers.get("etag") ?? "").replace(/"/g, "");
  if (head.ok && expected > 0 && fs.existsSync(target) && fs.statSync(target).size === expected) {
    const localTag = remoteTag ? fileFingerprint(target) : "";
    if (!remoteTag || localTag === remoteTag) {
      console.log(`  исходник уже есть локально: ${(expected / 1e6).toFixed(1)} МБ`);
      return;
    }
    console.log("  исходник на сайте другой (тот же размер, иной отпечаток) — качаю заново");
  }
  const res = await fetch(url, { headers: { Authorization: AUTH } });
  if (!res.ok || !res.body) throw new Error(`исходник недоступен: ${res.status}`);
  const tmp = target + ".part";
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (expected > 0 && size !== expected) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`исходник скачался не целиком: ${size} из ${expected} байт`);
  }
  fs.renameSync(tmp, target);
  console.log(`  исходник получен: ${(size / 1e6).toFixed(1)} МБ`);
}

async function uploadResult(id: string, file: string, which: "out" | "cover"): Promise<void> {
  const full = path.join(projectDir(id), file);
  if (!fs.existsSync(full)) return;
  // кусками по 4 МБ: прокси хостинга обрывает большие тела запросов
  const CHUNK = 4 * 1024 * 1024;
  const data = fs.readFileSync(full);
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    let attempt = 0;
    for (;;) {
      const res = await fetch(`${SITE}/api/worker/result/${id}?file=${which}`, {
        method: "PUT",
        headers: {
          Authorization: AUTH,
          "Content-Type": "application/octet-stream",
          "x-offset": String(offset),
          "x-file-size": String(data.length),
        },
        body: new Uint8Array(chunk),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        offset = json.done ? data.length : typeof json.received === "number" ? json.received : offset + chunk.length;
        break;
      }
      if (res.status === 409 && typeof json.received === "number") {
        offset = json.received;
        break;
      }
      if (++attempt >= 3) throw new Error(`Загрузка ${file}: ${res.status} ${json.error ?? ""}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log(`  залит ${file} (${(data.length / 1e6).toFixed(1)} МБ)`);
}

/**
 * Сводки прогонов (cost-runs/*.json: сумма и разбивка по провайдерам) уходят на сайт —
 * там журнал расходов и остатки на дашборде. Без аргумента отправляются все прогоны
 * всех проектов (при старте): сайт различает их по runId, повтор безопасен.
 */
async function sendRunLedgers(projectId?: string): Promise<void> {
  const runs: SpendRun[] = [];
  const ids = projectId ? [projectId] : fs.existsSync(UPLOADS_DIR) ? fs.readdirSync(UPLOADS_DIR) : [];
  for (const id of ids) {
    const dir = path.join(UPLOADS_DIR, id, "cost-runs");
    if (!fs.existsSync(dir)) continue;
    const topic = getProject(id)?.topic;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        runs.push(runFromLedgerFile(path.join(dir, f), id, f.endsWith("-failed.json") ? "failed" : "done", topic));
      } catch {}
    }
  }
  if (!runs.length) return;
  const res = (await api("/api/worker/spend", { method: "POST", body: JSON.stringify({ runs }) })) as { added?: number };
  if (res?.added) console.log(`  журнал расходов: отправлено прогонов ${runs.length}, новых ${res.added}`);
}

async function runJob(id: string): Promise<void> {
  console.log(`▶ Задача ${id}: забираю…`);
  const { project } = (await api("/api/worker/claim", { method: "POST", body: JSON.stringify({ id }) })) as {
    project: Project;
  };

  // Локальная копия проекта для конвейера. Исследование истории и блоки сценария
  // живут у воркера: если сайт их не прислал (старый сайт или проект без них),
  // сохранённые локально остаются — иначе повторный монтаж заново платил бы за
  // исследование, а с новым отпечатком — и за всю медиатеку.
  const local = getProject(id);
  upsertProject({
    ...project,
    research: project.research ?? local?.research,
    scriptBeats: project.scriptBeats ?? local?.scriptBeats,
    processedVideo: null,
    processing: { state: "idle", step: "", progress: 0 },
  });
  // Пульс на сайт от начала до конца задачи. Сайт считает воркер выключенным после
  // 90 секунд тишины и запускает монтаж у себя; скачивание исходника и отправка
  // результата раньше шли без сигналов — на большом файле это давало второй,
  // серверный монтаж и двойную оплату. Пока конвейер работает, идёт его прогресс.
  let phase = { step: "Скачивание исходника", progress: 2 };
  const heartbeat = setInterval(async () => {
    const cur = getProject(id);
    const running = cur && cur.processing.state === "running";
    api("/api/worker/progress", {
      method: "POST",
      body: JSON.stringify(running ? { id, step: cur.processing.step, progress: cur.processing.progress } : { id, ...phase }),
    }).catch(() => {});
  }, 2000);

  try {
    await downloadRaw(project);
    await syncFace();
    await processProject(id);

    const done = getProject(id)!;
    if (done.processing.state === "done") {
      phase = { step: "Отправка результата", progress: 99 };
      await uploadResult(id, "out.mp4", "out");
      await uploadResult(id, "cover.jpg", "cover");
      await api(`/api/worker/complete/${id}`, {
        method: "POST",
        body: JSON.stringify({
          subtitlesSource: done.subtitlesSource,
          brollCount: done.brollCount ?? 0,
          coverOffsetSec: done.coverOffsetSec ?? 1,
          meta: done.meta,
          research: done.research,
        }),
      });
      console.log(`✔ Задача ${id} готова`);
    } else {
      await api(`/api/worker/complete/${id}`, {
        method: "POST",
        // исследование построено и оплачено — сайт получает его и после неудачи
        body: JSON.stringify({ error: done.processing.error ?? "Неизвестная ошибка воркера", research: done.research }),
      });
      console.log(`✖ Задача ${id} упала: ${done.processing.error}`);
    }
  } finally {
    clearInterval(heartbeat);
    // сводка прогона — и удачного, и упавшего: деньги потрачены в обоих случаях
    await sendRunLedgers(id).catch((e) => console.warn("  журнал расходов не отправлен:", e?.message ?? e));
  }
}

async function main() {
  if (!PASSWORD || PASSWORD.includes("ВПИШИТЕ")) {
    console.error("⚠ Не задан GUDINI_PASSWORD — впишите в .env пароль входа на сайт (SITE_PASSWORD на Railway),");
    console.error("  затем пересоздайте контейнер: docker compose up -d");
    console.error("  Жду обновления настроек…");
    await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
    process.exit(1);
  }
  console.log(`Гудини-воркер запущен → ${SITE}`);
  console.log("Монтаж пойдёт на этом компьютере. Ctrl+C для остановки.\n");
  // прошлые прогоны — в журнал расходов сайта (старый сайт без маршрута — не ошибка)
  sendRunLedgers().catch((e) => console.warn("журнал расходов при старте не отправлен:", e?.message ?? e));

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    try {
      const { jobs } = (await api("/api/worker/jobs")) as { jobs: string[] };
      if (!jobs.length) return;
      busy = true;
      for (const id of jobs) {
        try {
          await runJob(id);
        } catch (e: any) {
          console.error(`✖ Задача ${id}:`, e?.message ?? e);
          api(`/api/worker/complete/${id}`, {
            method: "POST",
            body: JSON.stringify({ error: String(e?.message ?? e) }),
          }).catch(() => {});
        }
      }
      busy = false;
    } catch (e: any) {
      console.error("Опрос сайта не удался:", e?.message ?? e);
      busy = false;
    }
  }, 5000);
}

main();
