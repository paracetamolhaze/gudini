export const API = "/clipy/api";

export type ApiError = { code: string; message: string; hint?: string };

export class RequestError extends Error {
  error: ApiError;
  status: number;
  constructor(error: ApiError, status: number) {
    super(error.message);
    this.error = error;
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let err: ApiError = { code: "HTTP_" + res.status, message: `Сервер ответил ошибкой ${res.status}` };
  try {
    const j = await res.json();
    if (j?.error) err = j.error;
    else if (j?.detail) err = { code: "HTTP_" + res.status, message: String(j.detail) };
  } catch {
    /* ignore */
  }
  throw new RequestError(err, res.status);
}

export async function getJSON<T>(path: string): Promise<T> {
  return handle<T>(await fetch(API + path, { cache: "no-store" }));
}

export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export async function patchJSON<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(API + path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export async function del<T>(path: string): Promise<T> {
  return handle<T>(await fetch(API + path, { method: "DELETE" }));
}

/** Multipart upload with progress (XHR, because fetch has no upload progress). */
export function upload<T>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API + path);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: any = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json as T);
      else reject(new RequestError(json?.error ?? { code: "HTTP_" + xhr.status, message: `Загрузка не удалась (${xhr.status})` }, xhr.status));
    };
    xhr.onerror = () => reject(new RequestError({ code: "NETWORK", message: "Связь прервалась во время загрузки." }, 0));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export type Hardware = { gpu_name: string; gpu_vram_mb: number; backend: string; execution_providers: string[]; notes: string[]; onnxruntime_version: string };
export type SystemInfo = {
  engine: { name: string; version: string; installed: boolean };
  hardware: Hardware;
  ffmpeg: string;
  ytdlp: string;
  cookies: { present: boolean; path: string };
  limits: { max_video_seconds: number; max_video_mb: number };
  busy_job: string | null;
};

export type Person = {
  id: string;
  frames_seen: number;
  coverage: number;
  avg_area_ratio: number;
  reference_frame: number;
  thumbnail_url: string;
  sample: { gender?: string };
};

export type Stage = { key: string; label: string; status: "pending" | "running" | "done" | "skipped" | "failed"; progress: number; note?: string };

export type Source = {
  id: string;
  kind: "url" | "upload";
  url?: string;
  status: "queued" | "processing" | "ready" | "failed" | "cancelled";
  error: ApiError | null;
  info?: { width: number; height: number; fps: number; duration: number; has_audio: boolean };
  persons: Person[];
  video_url: string | null;
  poster_url: string | null;
  job?: { id: string; status: string; stage: string; stage_label: string; progress: number; stages: Stage[] };
};

export type Face = { id: string; created_at: string; original_name?: string; warnings: string[]; face_width?: number; image_url: string; thumb_url: string };
export type Identity = { id: string; name: string; face_ids: string[]; created_at: string };

export type Job = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  stage?: string;
  stage_label?: string;
  stages: Stage[];
  quality: string;
  face_swap: boolean;
  target_person: string;
  background: { kind: string } | null;
  source_id: string;
  source?: { duration?: number; width?: number; height?: number; fps?: number; url?: string; kind?: string };
  error?: ApiError | null;
  result?: { video_url: string; poster_url: string; width: number; height: number; fps: number; duration: number; has_audio: boolean };
  created_at: string;
  queue_position: number;
  engine?: { swapper?: string; enhancer?: string | null; attempts?: number };
};
