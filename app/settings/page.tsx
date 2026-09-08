"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Button, ErrorState, Field, StatusBadge, TechDetails } from "@/app/components/ui";

type SettingsView = {
  anthropicKey: string;
  openaiKey: string;
  elevenLabsKey: string;
  pexelsKey: string;
  pixabayKey: string;
  runwayKey: string;
  music: boolean;
  face: boolean;
  coverFont: boolean;
  googleClientId: string;
  googleClientSecret: string;
  tiktokClientKey: string;
  tiktokClientSecret: string;
  metaAppId: string;
  metaAppSecret: string;
  metaConfigId: string;
  igAppId: string;
  igAppSecret: string;
  publicBaseUrl: string;
  connected: { youtube: boolean; tiktok: boolean; instagram: boolean };
  accounts: Record<PlatformName, Account[]>;
};

type PlatformName = "youtube" | "tiktok" | "instagram";
type Account = { id: string; label: string; at: string; active: boolean };

const PLATFORMS: { key: PlatformName; title: string; sub: string }[] = [
  { key: "youtube", title: "YouTube Shorts", sub: "Публикация через YouTube Data API" },
  { key: "tiktok", title: "TikTok", sub: "Публикация через Content Posting API" },
  { key: "instagram", title: "Instagram Reels", sub: "Аккаунт Business или Creator" },
];

export default function SettingsPage() {
  return (
    <Suspense>
      <Settings />
    </Suspense>
  );
}

/** Файл-настройка (фото, шрифт, музыка): состояние, загрузка, замена, удаление. */
function FileSetting({
  title,
  text,
  present,
  presentLabel,
  absentLabel,
  accept,
  preview,
  onUpload,
  onDelete,
}: {
  title: string;
  text: string;
  present: boolean;
  presentLabel: string;
  absentLabel: string;
  accept: string;
  preview?: ReactNode;
  onUpload: (file: File) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="setting-tile">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="spacer" />
        <StatusBadge tone={present ? "success" : "neutral"}>{present ? presentLabel : absentLabel}</StatusBadge>
      </div>
      <div className="hint">{text}</div>
      <div className="row" style={{ marginTop: 12 }}>
        {present && preview}
        <label className="btn btn-secondary btn-sm" style={{ margin: 0, cursor: "pointer" }}>
          {busy ? <span className="spin" /> : present ? "Заменить" : "Загрузить"}
          <input
            type="file"
            accept={accept}
            hidden
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              try {
                await onUpload(file);
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
        </label>
        {present && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onDelete()}>
            Удалить
          </Button>
        )}
      </div>
    </div>
  );
}

function Settings() {
  const [s, setS] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const query = useSearchParams();

  async function load() {
    setLoadError("");
    try {
      const res = await fetch("/api/settings");
      const j = await res.json().catch(() => null);
      if (!res.ok || !j) throw new Error(j?.error ?? `ответ ${res.status}`);
      setS(j);
    } catch (e: any) {
      setLoadError(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    void load();
    const err = query.get("error");
    if (err) setError(`Не удалось подключить аккаунт: ${err}`);
    const connected = query.get("connected");
    if (connected) setNotice("Аккаунт подключён.");
  }, [query]);

  if (!s) {
    return (
      <main>
        <div className="page-head">
          <h1 className="page-title">Настройки</h1>
        </div>
        {loadError ? <ErrorState title="Не удалось загрузить настройки" text={loadError} onRetry={() => void load()} /> : <div className="skeleton" style={{ height: 320 }} aria-busy="true" />}
      </main>
    );
  }

  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;

  function field(key: keyof SettingsView, value: string) {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
    setDirty(true);
  }

  async function save() {
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      if (!res.ok) throw new Error("Не удалось сохранить настройки");
      const fresh = await (await fetch("/api/settings")).json();
      setS(fresh);
      setSaved(true);
      setDirty(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function account_(platform: PlatformName, id: string, action: "activate" | "remove") {
    setError("");
    if (action === "remove" && !confirm("Отключить этот аккаунт? Подключить его снова можно через вход на платформе.")) return;
    const res = await fetch("/api/settings/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, id, action }),
    });
    const j = await res.json().catch(() => null);
    if (j?.error) {
      setError(j.error);
      return;
    }
    const fresh = await fetch("/api/settings").then((r) => r.json());
    setS(fresh);
  }

  async function connect(platform: string) {
    setError("");
    const res = await fetch(`/api/auth/${platform}`, { redirect: "manual" });
    if (res.type === "opaqueredirect" || res.status === 0) {
      window.location.href = `/api/auth/${platform}`;
      return;
    }
    const j = await res.json().catch(() => null);
    if (j?.error) setError(j.error);
    else window.location.href = `/api/auth/${platform}`;
  }

  async function uploadTo(url: string, file: File, key: "face" | "coverFont" | "music", fail: string) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(url, { method: "POST", body: form });
    if (res.ok) setS((prev) => (prev ? { ...prev, [key]: true } : prev));
    else setError((await res.json().catch(() => ({}))).error ?? fail);
  }
  async function deleteAt(url: string, key: "face" | "coverFont" | "music", what: string) {
    if (!confirm(`Удалить ${what}?`)) return;
    await fetch(url, { method: "DELETE" });
    setS((prev) => (prev ? { ...prev, [key]: false } : prev));
  }

  const saveBar = (
    <div className="actions" style={{ marginTop: 8 }}>
      <Button onClick={save} busy={saving} disabled={!dirty && !saving}>
        Сохранить настройки
      </Button>
      {saved && <StatusBadge tone="success">Сохранено</StatusBadge>}
      {dirty && !saved && <StatusBadge tone="warn">Есть несохранённые изменения</StatusBadge>}
    </div>
  );

  return (
    <main>
      <div className="page-head">
        <h1 className="page-title">Настройки</h1>
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="success-box">{notice}</div>}

      {/* ---------- Аккаунты ---------- */}
      <div className="card">
        <h2>Аккаунты</h2>
        <p className="hint" style={{ marginBottom: 12 }}>Публикация идёт в активный аккаунт каждой платформы. Новое подключение не стирает прежние.</p>
        <div className="settings-grid">
          {PLATFORMS.map((p) => {
            const list = s.accounts[p.key] ?? [];
            const active = list.find((a) => a.active);
            return (
              <div className="setting-tile" key={p.key}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <h3 style={{ margin: 0 }}>{p.title}</h3>
                  <span className="spacer" />
                  <StatusBadge tone={s.connected[p.key] ? "success" : "neutral"}>{s.connected[p.key] ? "Подключён" : "Не подключён"}</StatusBadge>
                </div>
                <div className="hint">{active ? `Активен: ${active.label}` : p.sub}</div>
                {list.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {list.map((account) => (
                      <div key={account.id} className="account-row">
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{account.label}</span>
                        {account.active && <StatusBadge tone="accent">Активен</StatusBadge>}
                        <span className="spacer" />
                        {!account.active && (
                          <button type="button" className="link-btn" onClick={() => account_(p.key, account.id, "activate")}>
                            Сделать активным
                          </button>
                        )}
                        <button type="button" className="link-btn" style={{ color: "var(--text-dim)" }} onClick={() => account_(p.key, account.id, "remove")}>
                          Отключить
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="actions" style={{ marginTop: 12 }}>
                  <Button variant={s.connected[p.key] ? "secondary" : "primary"} size="sm" onClick={() => connect(p.key)}>
                    {s.connected[p.key] ? "Подключить ещё аккаунт" : "Подключить"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <TechDetails summary="Ключи приложений платформ">
          <p className="hint" style={{ marginBottom: 8 }}>
            Нужны один раз при настройке сервера: приложение разработчика на каждой платформе и его ключи. Адреса возврата для приложений:{" "}
            <code>{origin}/api/auth/youtube/callback</code>, <code>{origin}/api/auth/tiktok/callback</code>, <code>{origin}/api/auth/instagram/callback</code>.
          </p>
          <Field label="Google Client ID">
            <input type="text" value={s.googleClientId} onChange={(e) => field("googleClientId", e.target.value)} />
          </Field>
          <Field label="Google Client Secret">
            <input type="password" value={s.googleClientSecret} onChange={(e) => field("googleClientSecret", e.target.value)} />
          </Field>
          <Field label="TikTok Client Key">
            <input type="text" value={s.tiktokClientKey} onChange={(e) => field("tiktokClientKey", e.target.value)} />
          </Field>
          <Field label="TikTok Client Secret">
            <input type="password" value={s.tiktokClientSecret} onChange={(e) => field("tiktokClientSecret", e.target.value)} />
          </Field>
          <Field label="Instagram App ID" note="Прямой вход через Instagram: сценарий «API setup with Instagram business login» в приложении Meta.">
            <input type="text" value={s.igAppId} onChange={(e) => field("igAppId", e.target.value)} />
          </Field>
          <Field label="Instagram App Secret">
            <input type="password" value={s.igAppSecret} onChange={(e) => field("igAppSecret", e.target.value)} />
          </Field>
          <Field label="Meta App ID" note="Запасной вход через Facebook. Работает только если поля Instagram App ID и Secret пустые.">
            <input type="text" value={s.metaAppId} onChange={(e) => field("metaAppId", e.target.value)} />
          </Field>
          <Field label="Meta App Secret">
            <input type="password" value={s.metaAppSecret} onChange={(e) => field("metaAppSecret", e.target.value)} />
          </Field>
          <Field label="Meta Configuration ID" note="Вход через Facebook для бизнеса принимает только ID конфигурации.">
            <input type="text" value={s.metaConfigId} onChange={(e) => field("metaConfigId", e.target.value)} />
          </Field>
          <Field label="Публичный адрес сервера" note="Нужен Instagram после деплоя.">
            <input type="text" value={s.publicBaseUrl} onChange={(e) => field("publicBaseUrl", e.target.value)} placeholder="https://example.com" />
          </Field>
          {saveBar}
        </TechDetails>
      </div>

      {/* ---------- Оформление ---------- */}
      <div className="card">
        <h2>Оформление</h2>
        <div className="settings-grid">
          <FileSetting
            title="Фото автора"
            text="Образец лица для обложки: по нему создаётся портрет и проверяется, что на обложке именно вы. Одно фото анфас при хорошем свете."
            present={s.face}
            presentLabel="Загружено"
            absentLabel="Нет фото"
            accept="image/*"
            preview={<img src={`/api/settings/face?t=${Date.now()}`} alt="Фото автора" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 10, border: "1px solid var(--border)" }} />}
            onUpload={(file) => uploadTo("/api/settings/face", file, "face", "Не удалось загрузить фото")}
            onDelete={() => deleteAt("/api/settings/face", "face", "фото автора")}
          />
          <FileSetting
            title="Шрифт обложек"
            text="Свой шрифт для заголовков обложек, файл TTF или OTF с кириллицей. Без него используется встроенный."
            present={s.coverFont}
            presentLabel="Свой шрифт"
            absentLabel="Встроенный"
            accept=".ttf,.otf"
            onUpload={(file) => uploadTo("/api/settings/coverfont", file, "coverFont", "Не удалось загрузить шрифт")}
            onDelete={() => deleteAt("/api/settings/coverfont", "coverFont", "свой шрифт")}
          />
          <FileSetting
            title="Фоновая музыка"
            text="Трек MP3 до 30 МБ тихо играет под каждым роликом и приглушается, пока вы говорите. Используйте музыку без ограничений по правам."
            present={s.music}
            presentLabel="Трек загружен"
            absentLabel="Без музыки"
            accept="audio/*"
            onUpload={(file) => uploadTo("/api/settings/music", file, "music", "Не удалось загрузить музыку")}
            onDelete={() => deleteAt("/api/settings/music", "music", "фоновую музыку")}
          />
        </div>
      </div>

      {/* ---------- Сервисы ---------- */}
      <div className="card">
        <h2>Сервисы</h2>
        <p className="hint">Ключи хранятся на сервере и показываются замаскированными. Пустое поле отключает сервис.</p>
        <Field label="Anthropic API Key" note="Сценарии и описания.">
          <input type="password" value={s.anthropicKey} onChange={(e) => field("anthropicKey", e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
        </Field>
        <Field label="ElevenLabs API Key" note="Точные субтитры по речи.">
          <input type="password" value={s.elevenLabsKey} onChange={(e) => field("elevenLabsKey", e.target.value)} placeholder="xi-…" autoComplete="off" />
        </Field>
        <Field label="Pexels API Key" note="Стоковые видео для перебивок в версии с картинками.">
          <input type="password" value={s.pexelsKey} onChange={(e) => field("pexelsKey", e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Pixabay API Key" note="Второй источник стоковых видео.">
          <input type="password" value={s.pixabayKey} onChange={(e) => field("pixabayKey", e.target.value)} autoComplete="off" />
        </Field>
        <TechDetails summary="Прочие ключи">
          <Field label="Runway API Key" note="Текущий монтаж и обложки этот ключ не используют. Поле оставлено для совместимости.">
            <input type="password" value={s.runwayKey} onChange={(e) => field("runwayKey", e.target.value)} autoComplete="off" />
          </Field>
        </TechDetails>
        {saveBar}
      </div>
    </main>
  );
}
