import { getSettings, listAccounts, updateAccountTokens, type InstagramTokens } from "../store";
import type { PublishAccount } from "./types";

/**
 * Аккаунты Instagram для каруселей — те же, что подключены в Настройках (savedAccounts).
 * Публикация закрепляет конкретный аккаунт в момент постановки (сейчас или по расписанию):
 * переключение активного аккаунта в Настройках после этого её не перенаправляет.
 * Токен закреплённого аккаунта продлевается в его собственной записи, а не в активной.
 */

export type InstagramAccountChoice = PublishAccount & { active: boolean; expiresInDays: number | null };

export function listInstagramAccounts(now = Date.now()): InstagramAccountChoice[] {
  // listAccounts переносит аккаунт, подключённый до появления списка, в savedAccounts
  const meta = listAccounts("instagram");
  const s = getSettings();
  const out: InstagramAccountChoice[] = [];
  for (const a of s.savedAccounts?.instagram ?? []) {
    const t = a.tokens as InstagramTokens;
    if (!t?.access_token || !t.ig_user_id) continue;
    out.push({
      id: a.id,
      igUserId: t.ig_user_id,
      label: a.label || null,
      via: t.via === "ig" ? "ig" : "fb",
      active: meta.find((m) => m.id === a.id)?.active ?? false,
      expiresInDays: t.expires_at ? Math.floor((t.expires_at - now) / 86_400_000) : null,
    });
  }
  return out;
}

export function findInstagramAccount(id?: string | null, now = Date.now()): InstagramAccountChoice | null {
  const list = listInstagramAccounts(now);
  if (id) return list.find((a) => a.id === id) ?? null;
  return list.find((a) => a.active) ?? null;
}

export type InstagramAccountInfo = {
  connected: boolean;
  label: string | null;
  via: "ig" | "fb" | null;
  igUserId: string | null;
  expiresInDays: number | null;
  publicBaseUrl: string | null;
  /** что мешает публикации — готовые фразы; пустой список — можно публиковать */
  problems: string[];
};

/** Готов ли аккаунт (по умолчанию активный) и сайт к публикации. Только чтение. */
export function instagramAccountInfo(accountId?: string | null, now = Date.now()): InstagramAccountInfo {
  const s = getSettings();
  const a = findInstagramAccount(accountId, now);
  const problems: string[] = [];
  if (!a) {
    problems.push(
      accountId
        ? "Закреплённый аккаунт Instagram больше не подключён — подключите его снова в Настройках или выберите другой."
        : "Instagram не подключён: Настройки → «Подключить Instagram» (нужен аккаунт Business или Creator).",
    );
  } else if (a.expiresInDays !== null && a.expiresInDays < 0) problems.push("Токен Instagram истёк — переподключите Instagram в Настройках.");

  const base = s.publicBaseUrl ?? null;
  if (!base) problems.push("Не задан публичный адрес сайта (PUBLIC_BASE_URL): Instagram скачивает слайды по ссылке.");
  else if (!/^https:\/\//i.test(base)) problems.push("Публичный адрес сайта должен начинаться с https:// — иначе Instagram не скачает слайды.");
  else if (/\/\/(localhost|127\.|10\.|192\.168\.)/i.test(base)) problems.push("Публичный адрес сайта указывает на локальную сеть — Instagram его не увидит.");

  return { connected: Boolean(a), label: a?.label ?? null, via: a?.via ?? null, igUserId: a?.igUserId ?? null, expiresInDays: a?.expiresInDays ?? null, publicBaseUrl: base, problems };
}

export const toPublishAccount = (a: InstagramAccountChoice): PublishAccount => ({ id: a.id, igUserId: a.igUserId, label: a.label, via: a.via });

/**
 * Токен закреплённого аккаунта. Длинный токен Instagram живёт 60 дней и продлевается ещё
 * на 60; продлеваем заранее (меньше недели до конца), неудача не мешает — текущий ещё жив.
 * Запись — в собственную запись аккаунта: активный при этом не затирается.
 */
export async function accountAccessToken(account: PublishAccount, deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  const s = getSettings();
  const saved = (s.savedAccounts?.instagram ?? []).find((a) => a.id === account.id);
  const tokens = saved?.tokens as InstagramTokens | undefined;
  if (!tokens?.access_token) throw new Error("Закреплённый аккаунт Instagram больше не подключён");
  const WEEK = 7 * 24 * 3600 * 1000;
  if (tokens.via === "fb" || account.via === "fb") return tokens.access_token;
  if (tokens.expires_at && tokens.expires_at - now() > WEEK) return tokens.access_token;
  try {
    const res = await (deps.fetch ?? fetch)(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tokens.access_token}`);
    const json: any = await res.json();
    if (json?.access_token) {
      const fresh: InstagramTokens = { ...tokens, access_token: json.access_token, expires_at: now() + (json.expires_in ?? 60 * 24 * 3600) * 1000 };
      updateAccountTokens("instagram", account.id, fresh);
      return fresh.access_token;
    }
  } catch {}
  return tokens.access_token;
}
