"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

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

const PLATFORM_TITLES: Record<PlatformName, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
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

  async function account_(platform: PlatformName, id: string, action: "activate" | "remove") {
    setError("");
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
        <label>Pixabay API Key — второй источник стока, бесплатно (pixabay.com/api/docs)</label>
        <input type="password" value={s.pixabayKey} onChange={(e) => field("pixabayKey", e.target.value)} />
        <label>
          Runway API Key — ИИ-генерация перебивок точно под фразу (dev.runwayml.com, ~$0.30 за клип). Если ключ
          вставлен — используется вместо стока; сток остаётся запасным.
        </label>
        <input type="password" value={s.runwayKey} onChange={(e) => field("runwayKey", e.target.value)} placeholder="key_…" />
      </div>

      <div className="card">
        <h2>🧑‍🎤 Фото стримера — для ИИ-обложек</h2>
        <p className="hint">
          Загрузите одно хорошее фото лица (анфас, хороший свет). Для каждого ролика ИИ будет создавать обложку
          с нуля: ваше узнаваемое лицо крупным планом, новая эмоция под тему, драматичный сюжетный фон и крупный
          заголовок. Нужен ключ Runway. Чтобы обновить лицо — просто замените фото. Без фото обложка делается из
          кадра видео.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          {s.face ? (
            <>
              <img
                src={`/api/settings/face?t=${Date.now()}`}
                alt="Фото стримера"
                style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 12, border: "1px solid var(--border)" }}
              />
              <span className="badge success">Фото загружено ✓</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await fetch("/api/settings/face", { method: "DELETE" });
                  setS((prev) => (prev ? { ...prev, face: false } : prev));
                }}
              >
                Удалить
              </button>
            </>
          ) : (
            <span className="badge">Фото нет — обложки из кадра видео</span>
          )}
          <label className="btn btn-secondary btn-sm" style={{ margin: 0, cursor: "pointer" }}>
            📷 {s.face ? "Заменить фото" : "Загрузить фото"}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append("file", file);
                const res = await fetch("/api/settings/face", { method: "POST", body: form });
                if (res.ok) setS((prev) => (prev ? { ...prev, face: true } : prev));
                else setError("Не удалось загрузить фото");
              }}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>🅰 Шрифт обложек (Cover Font)</h2>
        <p className="hint">
          Загрузите свой дисплейный шрифт (.ttf/.otf, с кириллицей — например Druk Cyr Condensed, если у вас
          есть лицензия) — он станет главным шрифтом заголовков всех обложек. Без него используется встроенный
          Montserrat Black с фирменным сжатием.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          {s.coverFont ? (
            <>
              <span className="badge success">Свой шрифт загружен ✓</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  await fetch("/api/settings/coverfont", { method: "DELETE" });
                  setS((prev) => (prev ? { ...prev, coverFont: false } : prev));
                }}
              >
                Удалить
              </button>
            </>
          ) : (
            <span className="badge">Свой шрифт не загружен — используется встроенный</span>
          )}
          <label className="btn btn-secondary btn-sm" style={{ margin: 0, cursor: "pointer" }}>
            🅰 {s.coverFont ? "Заменить шрифт" : "Загрузить шрифт"}
            <input
              type="file"
              accept=".ttf,.otf"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.append("file", file);
                const res = await fetch("/api/settings/coverfont", { method: "POST", body: form });
                if (res.ok) setS((prev) => (prev ? { ...prev, coverFont: true } : prev));
                else setError((await res.json().catch(() => ({}))).error ?? "Не удалось загрузить шрифт");
              }}
            />
          </label>
        </div>
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
        <label>Meta Configuration ID (для «Входа через Facebook для бизнеса»)</label>
        <input type="text" value={s.metaConfigId} onChange={(e) => field("metaConfigId", e.target.value)} />
        <p className="hint">
          Приложение → «Вход через Facebook для бизнеса» → <b>Конфигурации</b> → ID конфигурации. Этот вход не
          принимает список разрешений — только ID конфигурации. Чтобы использовать вход через Facebook, поля
          Instagram App ID/Secret выше должны быть <b>пустыми</b>.
        </p>
        <label>Публичный URL сервера (после деплоя, для Instagram)</label>
        <input type="text" value={s.publicBaseUrl} onChange={(e) => field("publicBaseUrl", e.target.value)} placeholder="https://mysite.com" />
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>👥 Подключённые аккаунты</h3>
        <p className="hint">
          Публикация всегда идёт в активный аккаунт. Подключение нового не стирает старый — можно
          переключаться без повторного входа.
        </p>
        {(Object.keys(PLATFORM_TITLES) as PlatformName[]).map((platform) => (
          <div key={platform} style={{ marginTop: 12 }}>
            <label>{PLATFORM_TITLES[platform]}</label>
            {s.accounts[platform].length === 0 ? (
              <p className="hint">Нет подключённых аккаунтов.</p>
            ) : (
              s.accounts[platform].map((account) => (
                <div key={account.id} className="row" style={{ alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span>{account.label}</span>
                  {account.active && <span className="badge success">активен</span>}
                  <div className="spacer" />
                  {!account.active && (
                    <button className="btn btn-secondary btn-sm" onClick={() => account_(platform, account.id, "activate")}>
                      Сделать активным
                    </button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => account_(platform, account.id, "remove")}>
                    Удалить
                  </button>
                </div>
              ))
            )}
          </div>
        ))}
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
