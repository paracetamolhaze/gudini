/** Thin fetch wrapper for the dashboard. The prefix matches the Fastify mount (default /threads). */
export const PREFIX = (import.meta.env.BASE_URL || "/threads/").replace(/\/+$/, "");
export const API = `${PREFIX}/api`;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    credentials: "same-origin",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    if (res.status === 401) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
