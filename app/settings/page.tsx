"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type SettingsView = {
  anthropicKey: string;
  openaiKey: string;
  elevenLabsKey: string;
  pexelsKey: string;
  music: boolean;
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
        <label>ElevenLabs API Key — Scribe, точные субтитры по речи (elevenlabs.io → Profile → API Keys)</label>
        <input type="password" value={s.elevenLabsKey} onChange={(e) => field("elevenLabsKey", e.target.value)} placeholder="xi-…" />
        <label>OpenAI API Key — Whisper, запасной вариант субтитров (platform.openai.com)</label>
        <input type="password" value={s.openaiKey} onChange={(e) => field("openaiKey", e.target.value)} placeholder="sk-…" />
        <label>Pexels API Key — стоковые видео для б-ролл перебивок, бесплатно (pexels.com/api)</label>
        <input type="password" value={s.pexelsKey} onChange={(e) => field("pexelsKey", e.target.value)} />
      </div>

      <div className="card">
        <h2>🎵 Фоновая музыка</h2>
        <p className="hint">
          Загрузите трек (MP3, до 30 МБ) — он будет тихо играть под каждым роликом и автоматически приглушаться,
          когда вы говорите. Используйте музыку, свободную от авторских прав (например, из фонотек платформ).
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          {s.music ? (
            <>
              <span className="badge success">Трек загружен ✓</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await fetch("/api/settings/music", { method: "DELETE" });
                  setS((prev) => (prev ? { ...prev, music: false } : prev));
                }}
              >
                Удалить
              </button>
            </>
          ) : (
            <span className="badge">Музыки нет — ролики монтируются без неё</span>
          )}
          <label className="btn btn-secondary btn-sm" style={{ margin: 0, cursor: "pointer" }}>
            📁 Загрузить трек
            <input
              type="file"
              accept="audio/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append("file", file);
                const res = await fetch("/api/settings/music", { method: "POST", body: form });
                if (res.ok) setS((prev) => (prev ? { ...prev, music: true } : prev));
                else setError("Не удалось загрузить музыку");
              }}
            />
          </label>
        </div>
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
          Рекомендуемый способ — прямой вход через Instagram: в приложении Meta откройте сценарий Instagram → «API
          setup with Instagram business login» и возьмите оттуда Instagram App ID/Secret. Аккаунт должен быть
          Business/Creator; Facebook-страница и бизнес-портфолио не нужны. Redirect URI:{" "}
          <code>{origin}/api/auth/instagram/callback</code>
        </p>
        <label>Instagram App ID</label>
        <input type="text" value={s.igAppId} onChange={(e) => field("igAppId", e.target.value)} />
        <label>Instagram App Secret</label>
        <input type="password" value={s.igAppSecret} onChange={(e) => field("igAppSecret", e.target.value)} />
        <p className="hint" style={{ marginTop: 14 }}>
          Запасной способ — вход через Facebook (нужна привязанная страница FB):
        </p>
        <label>Meta App ID</label>
        <input type="text" value={s.metaAppId} onChange={(e) => field("metaAppId", e.target.value)} />
        <label>Meta App Secret</label>
        <input type="password" value={s.metaAppSecret} onChange={(e) => field("metaAppSecret", e.target.value)} />
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
