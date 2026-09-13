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

export async function api<T>(url: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Сервер не отвечает — проверьте соединение и повторите", 0, "network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `Ошибка ${res.status}`, res.status, data?.code);
  return data as T;
}

export const isAccessError = (e: unknown): boolean => e instanceof ApiError && e.status === 401;

export function AccessNotice(_: { error: ApiError }) {
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

export const money = (v: number) => (v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(2)}`);

export const JOB_TITLES: Record<JobType, string> = {
  generate: "Генерация карусели",
  render: "Сборка карточек",
  regenerate_slide: "Перегенерация слайда",
  instruct: "Правка по поручению",
  images: "Иллюстрации",
  image: "Иллюстрация слайда",
  publish: "Публикация в Instagram",
  verify_publish: "Проверка публикации",
};

export const isPending = (job: CarouselJob | null | undefined) => job?.state === "queued" || job?.state === "running";

/** Состояние раздела с /api/carousel/status: без значений ключей. */
export type SectionStatus = {
  config: { keyEnv: string; keySet: boolean; problems: string[]; textModel: string; imageModel: string | null; resolution: string; budgets: { monthlyUsd: number; perCarouselUsd: number } };
  key: { label: string | null; limit: number | null; usage: number; remaining: number | null } | null;
  keyError: string | null;
  models: { id: string; label: string; vendor: string; available: boolean | null; reason: string | null; resolution: string | null; perImageUsd: number; pricing: string; note?: string; resolutions: string[] | null }[];
  modelsCheckedAt: string;
  pricing: { textPlanUsd: number; textEditUsd: number };
  budget: { monthlyLimitUsd: number; perCarouselLimitUsd: number; monthSpentUsd: number; monthPendingUsd: number; monthRemainingUsd: number; month: string; disabled: boolean };
  instagram: { connected: boolean; label: string | null; problems: string[]; accounts: { id: string; igUserId: string; label: string | null; via: string; active: boolean; expiresInDays: number | null }[] };
  design: { accent: string; textColor: string; scrimColor: string; titleFont: "display" | "condensed"; author: string; logoFile?: string; illustrationStyle: string; referenceFile?: string };
  timeZone: string;
  timeZones: string[];
  limits: { slides: { min: number; max: number; default: number } };
};
