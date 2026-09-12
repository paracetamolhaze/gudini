"use client";

import type { CarouselJob, JobType } from "@/lib/carousel/types";

/** Общие мелочи страниц раздела «Карусели»: запросы к API, отказ в доступе, подписи. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(url: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Сервер не отвечает — проверьте соединение и повторите", 0, "network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `Ошибка ${res.status}`, res.status, data?.code);
  return data as T;
}

export const isAccessError = (e: unknown): boolean => e instanceof ApiError && (e.status === 401 || e.code === "login_disabled");

export function AccessNotice({ error }: { error: ApiError }) {
  if (error.code === "login_disabled") {
    return (
      <div className="warn-box" role="alert">
        <strong>Раздел закрыт.</strong> {error.message}
      </div>
    );
  }
  return (
    <div className="warn-box" role="alert">
      Нужен вход на сайт.{" "}
      <a className="link-btn" href="/login?next=/carousel">
        Войти
      </a>
    </div>
  );
}

export function formatDate(iso: string, withTime = false): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const JOB_TITLES: Record<JobType, string> = {
  generate: "Генерация карусели",
  render: "Рендер слайдов",
  regenerate_slide: "Перегенерация слайда",
  instruct: "Правка по поручению",
  publish: "Публикация в Instagram",
  verify_publish: "Проверка публикации",
};

export const isPending = (job: CarouselJob | null | undefined) => job?.state === "queued" || job?.state === "running";
