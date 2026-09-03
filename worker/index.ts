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
import { getProject, upsertProject, projectDir, Project } from "../lib/store";
import { processProject } from "../lib/pipeline";

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
  if (head.ok && expected > 0 && fs.existsSync(target) && fs.statSync(target).size === expected) {
    console.log(`  исходник уже есть локально: ${(expected / 1e6).toFixed(1)} МБ`);
    return;
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
  await downloadRaw(project);
  await syncFace();

  // трансляция прогресса на сайт
  const forwarder = setInterval(async () => {
    const local = getProject(id);
    if (!local || local.processing.state !== "running") return;
    api("/api/worker/progress", {
      method: "POST",
      body: JSON.stringify({ id, step: local.processing.step, progress: local.processing.progress }),
    }).catch(() => {});
  }, 2000);

  try {
    await processProject(id);
  } finally {
    clearInterval(forwarder);
  }

  const done = getProject(id)!;
  if (done.processing.state === "done") {
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
