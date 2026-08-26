"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type SettingsView = {
  anthropicKey: string;
  openaiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  tiktokClientKey: string;
  tiktokClientSecret: string;
  metaAppId: string;
  metaAppSecret: string;
  metaConfigId: string;
  publicBaseUrl: string;
  connected: { youtube: boolean; tiktok: boolean; instagram: boolean };
};

export default function SettingsPage() {
  return (
    <Suspense>
      <Settings />
    </Suspense>
  );
}

function Settings() {
  const [s, setS] = useState<SettingsView | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const query = useSearchParams();

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setS);
    const err = query.get("error");
    if (err) setError(`Ошибка подключения: ${err}`);
    const connected = query.get("connected");
    if (connected) setSaved(true);
  }, [query]);

  if (!s) return <p className="hint">Загрузка…</p>;

  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;

  function field(key: keyof SettingsView, value: string) {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }

  async function save() {
    setError("");
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    if (res.ok) {
      setSaved(true);
      const fresh = await (await fetch("/api/settings")).json();
      setS(fresh);
    } else setError("Не удалось сохранить");
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

  return (
    <main>
      <div className="card">
        <h2>🤖 ИИ-ключи</h2>
        <p className="hint">
          Значения хранятся локально в <code>data/settings.json</code> (или задаются через <code>.env</code>). Без
          ключей всё работает в демо-режиме.
        </p>
        <label>Anthropic API Key — сценарии и описания (console.anthropic.com)</label>
        <input type="password" value={s.anthropicKey} onChange={(e) => field("anthropicKey", e.target.value)} placeholder="sk-ant-…" />
        <label>OpenAI API Key — Whisper, точные субтитры по речи (platform.openai.com)</label>
        <input type="password" value={s.openaiKey} onChange={(e) => field("openaiKey", e.target.value)} placeholder="sk-…" />
      </div>

      <div className="card">
        <h2>📡 Платформы публикации</h2>
        <p className="hint">
          Для каждой платформы нужно создать приложение разработчика и вписать его ключи, затем подключить аккаунт.
          Пока аккаунт не подключён, кнопка «Опубликовать» работает в демо-режиме.
        </p>

        <h3 style={{ margin: "18px 0 4px", fontSize: 15 }}>▶️ YouTube Shorts {s.connected.youtube && <span className="badge success">подключён</span>}</h3>
        <p className="hint">
          Google Cloud Console → включить YouTube Data API v3 → OAuth Client (Web) → Redirect URI:{" "}
          <code>{origin}/api/auth/youtube/callback</code>
        </p>
        <label>Google Client ID</label>
        <input type="text" value={s.googleClientId} onChange={(e) => field("googleClientId", e.target.value)} />
        <label>Google Client Secret</label>
        <input type="password" value={s.googleClientSecret} onChange={(e) => field("googleClientSecret", e.target.value)} />

        <h3 style={{ margin: "22px 0 4px", fontSize: 15 }}>🎵 TikTok {s.connected.tiktok && <span className="badge success">подключён</span>}</h3>
        <p className="hint">
          developers.tiktok.com → приложение с Content Posting API → Redirect URI:{" "}
          <code>{origin}/api/auth/tiktok/callback</code>
        </p>
        <label>TikTok Client Key</label>
        <input type="text" value={s.tiktokClientKey} onChange={(e) => field("tiktokClientKey", e.target.value)} />
        <label>TikTok Client Secret</label>
        <input type="password" value={s.tiktokClientSecret} onChange={(e) => field("tiktokClientSecret", e.target.value)} />

        <h3 style={{ margin: "22px 0 4px", fontSize: 15 }}>📸 Instagram Reels {s.connected.instagram && <span className="badge success">подключён</span>}</h3>
        <p className="hint">
          developers.facebook.com → приложение с Instagram Graph API (нужен Business/Creator аккаунт, привязанный к
          странице Facebook). Для Reels также нужен публичный URL сервера.
        </p>
        <label>Meta App ID</label>
        <input type="text" value={s.metaAppId} onChange={(e) => field("metaAppId", e.target.value)} />
        <label>Meta App Secret</label>
        <input type="password" value={s.metaAppSecret} onChange={(e) => field("metaAppSecret", e.target.value)} />
        <label>
          Meta Configuration ID — для «Входа через Facebook для бизнеса»: продукт Facebook Login → Configurations →
          создать конфигурацию с разрешениями Instagram → скопировать ID
        </label>
        <input type="text" value={s.metaConfigId} onChange={(e) => field("metaConfigId", e.target.value)} placeholder="например 123456789012345" />
        <label>Публичный URL сервера (после деплоя, для Instagram)</label>
        <input type="text" value={s.publicBaseUrl} onChange={(e) => field("publicBaseUrl", e.target.value)} placeholder="https://mysite.com" />
      </div>

      {error && <div className="error-box">{error}</div>}
      {saved && <div className="success-box">Сохранено ✓</div>}

      <div className="row">
        <button className="btn" onClick={save}>
          💾 Сохранить настройки
        </button>
        <div className="spacer" />
        <button className="btn btn-secondary btn-sm" onClick={() => connect("youtube")}>
          Подключить YouTube
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => connect("tiktok")}>
          Подключить TikTok
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => connect("instagram")}>
          Подключить Instagram
        </button>
      </div>
    </main>
  );
}
