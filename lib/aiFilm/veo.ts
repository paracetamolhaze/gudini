import fs from "fs";
import path from "path";
import { GoogleAuth } from "google-auth-library";

/**
 * Клиент Veo на Vertex AI (REST). Ключей в коде нет: авторизация через Application
 * Default Credentials (файл gcloud auth application-default login, смонтирован в воркер
 * как GOOGLE_APPLICATION_CREDENTIALS) — токен получает google-auth-library.
 *
 * Генерация асинхронная: predictLongRunning возвращает имя операции, fetchPredictOperation
 * её опрашивает. Результат кладётся в GCS (storageUri) и скачивается сюда. Сюда никогда
 * не отправляется видео автора: только промпты, кадры и видео, которые сгенерировал сам Veo.
 */

export const GCP_PROJECT = process.env.GCP_PROJECT || "gudini-506711";
export const GCP_LOCATION = process.env.GCP_LOCATION || "us-central1";
export const VEO_BUCKET = process.env.VEO_BUCKET || "gudini-506711-veo";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const POLL_MS = Number(process.env.VEO_POLL_MS ?? 15000);
const POLL_MAX_MS = Number(process.env.VEO_POLL_MAX_MS ?? 15 * 60 * 1000);

let auth: GoogleAuth | null = null;

export function veoConfigured(): boolean {
  const f = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    return Boolean(f && fs.statSync(f).isFile() && fs.statSync(f).size > 50) || Boolean(process.env.GCE_METADATA_HOST);
  } catch {
    return Boolean(process.env.GCE_METADATA_HOST);
  }
}

async function token(): Promise<string> {
  if (!auth) auth = new GoogleAuth({ scopes: [SCOPE], projectId: GCP_PROJECT });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  if (!t?.token) throw new Error("Google Cloud: не удалось получить токен доступа (ADC)");
  return t.token;
}

async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", "User-Agent": "gudini/1.0" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vertex ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const modelUrl = (model: string, verb: string) =>
  `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${model}:${verb}`;

export type VeoRequest = {
  model: string;
  prompt: string;
  durationSeconds: number;
  /** папка результата в GCS, gs://bucket/path/ */
  storageUri: string;
  /** первый кадр (image-to-video): JPEG/PNG в GCS */
  imageGcsUri?: string;
  /** продолжение видео (extension): mp4 в GCS, сгенерированный Veo */
  videoGcsUri?: string;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
};

export function veoBody(r: VeoRequest): { instances: any[]; parameters: any } {
  const instance: any = { prompt: r.prompt };
  if (r.imageGcsUri) instance.image = { gcsUri: r.imageGcsUri, mimeType: r.imageGcsUri.endsWith(".png") ? "image/png" : "image/jpeg" };
  if (r.videoGcsUri) instance.video = { gcsUri: r.videoGcsUri, mimeType: "video/mp4" };
  return {
    instances: [instance],
    parameters: {
      aspectRatio: r.aspectRatio ?? "16:9",
      durationSeconds: r.durationSeconds,
      resolution: r.resolution ?? "720p",
      sampleCount: 1,
      generateAudio: false,
      personGeneration: "allow_adult",
      storageUri: r.storageUri,
    },
  };
}

/** Запуск генерации: возвращает имя операции. */
export async function startVeo(r: VeoRequest): Promise<string> {
  const out = await api("POST", modelUrl(r.model, "predictLongRunning"), veoBody(r));
  if (!out?.name) throw new Error(`Veo: ответ без имени операции: ${JSON.stringify(out).slice(0, 300)}`);
  return out.name as string;
}

export type VeoResult = { gcsUri: string; raw: any };

/** Опрос операции до готовности. Ошибка Veo — ошибка стадии, без автоповтора. */
export async function waitVeo(model: string, operationName: string, onTick?: (elapsedSec: number) => void): Promise<VeoResult> {
  const started = Date.now();
  for (;;) {
    const op = await api("POST", modelUrl(model, "fetchPredictOperation"), { operationName });
    if (op?.done) {
      if (op.error) throw new Error(`Veo: ${op.error.message ?? JSON.stringify(op.error)}`);
      const videos = op.response?.videos ?? op.response?.generatedSamples ?? [];
      const first = videos[0];
      const gcsUri: string | undefined = first?.gcsUri ?? first?.video?.uri ?? first?.uri;
      if (!gcsUri) {
        const filtered = op.response?.raiMediaFilteredReasons ?? op.response?.raiMediaFilteredCount;
        throw new Error(`Veo: результат без видео${filtered ? ` (фильтр безопасности: ${JSON.stringify(filtered).slice(0, 200)})` : ""}`);
      }
      return { gcsUri, raw: op.response };
    }
    const elapsed = (Date.now() - started) / 1000;
    onTick?.(elapsed);
    if (Date.now() - started > POLL_MAX_MS) throw new Error(`Veo: операция не завершилась за ${Math.round(POLL_MAX_MS / 60000)} мин`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function parseGcs(uri: string): { bucket: string; object: string } {
  const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`Не GCS-адрес: ${uri}`);
  return { bucket: m[1], object: m[2] };
}

export async function downloadGcs(uri: string, file: string): Promise<void> {
  const { bucket, object } = parseGcs(uri);
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, "User-Agent": "gudini/1.0" }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`GCS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  if (buf.length < 10_000) throw new Error(`GCS: скачанный файл подозрительно мал (${buf.length} байт)`);
}

export async function uploadGcs(file: string, uri: string, mimeType: string): Promise<void> {
  const { bucket, object } = parseGcs(uri);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": mimeType, "User-Agent": "gudini/1.0" },
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`GCS upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
