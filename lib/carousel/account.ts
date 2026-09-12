import { getSettings } from "../store";

/**
 * Подключение Instagram для каруселей — то же, что у публикации Reels: активный аккаунт
 * из Настроек (instagramTokens). Здесь только чтение: ничего не записывается и не продлевается.
 */

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

export function instagramAccountInfo(now = Date.now()): InstagramAccountInfo {
  const s = getSettings();
  const t = s.instagramTokens;
  const activeId = s.activeAccounts?.instagram;
  const label = s.savedAccounts?.instagram?.find((a) => a.id === activeId)?.label ?? null;
  const problems: string[] = [];

  if (!t?.access_token) problems.push("Instagram не подключён: Настройки → «Подключить Instagram» (нужен аккаунт Business или Creator).");
  else if (!t.ig_user_id) problems.push("У подключённого Instagram нет ID профессионального аккаунта — переподключите Instagram в Настройках.");

  const expiresInDays = t?.expires_at ? Math.floor((t.expires_at - now) / 86_400_000) : null;
  if (t?.access_token && expiresInDays !== null && expiresInDays < 0) problems.push("Токен Instagram истёк — переподключите Instagram в Настройках.");

  const base = s.publicBaseUrl ?? null;
  if (!base) problems.push("Не задан публичный адрес сайта (PUBLIC_BASE_URL): Instagram скачивает слайды по ссылке.");
  else if (!/^https:\/\//i.test(base)) problems.push("Публичный адрес сайта должен начинаться с https:// — иначе Instagram не скачает слайды.");
  else if (/\/\/(localhost|127\.|10\.|192\.168\.)/i.test(base)) problems.push("Публичный адрес сайта указывает на локальную сеть — Instagram его не увидит.");

  return {
    connected: Boolean(t?.access_token && t.ig_user_id),
    label,
    via: t ? (t.via === "ig" ? "ig" : "fb") : null,
    igUserId: t?.ig_user_id ?? null,
    expiresInDays,
    publicBaseUrl: base,
    problems,
  };
}
