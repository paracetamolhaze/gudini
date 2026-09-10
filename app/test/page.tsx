"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, StatusBadge } from "../components/ui";

/**
 * Стенд озвучки. Здесь живёт только новая часть — синтез речи Chatterbox Multilingual V3
 * на своей видеокарте. Основной поток (сценарий → запись → монтаж) страница не трогает:
 * в него переезжает уже проверенная настройка, а не эксперименты.
 *
 * Модель локальная, генерации бесплатны и не ограничены. Карта одна на всех: пока
 * clipy рендерит замену лица, модель лучше выгрузить кнопкой.
 */

type Health = {
  device: string;
  cuda: boolean;
  gpu: string | null;
  model: string;
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  vram: { totalMb?: number; freeMb?: number; usedMb?: number };
};
type Voice = { slug: string; seconds: number; sizeKb: number };
type Take = {
  id: string;
  text: string;
  chars: number;
  chunks: number;
  voice: string | null;
  language_id: string;
  exaggeration: number;
  cfg_weight: number;
  temperature: number;
  seed: number | null;
  note: string;
  seconds: number;
  elapsedSec: number;
  createdAt: string;
};

const api = (path: string) => `/api/test/tts/${path}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON — покажем как есть */
  }
  if (!res.ok) throw new Error(json?.error ?? json?.detail ?? text.slice(0, 300) ?? `ошибка ${res.status}`);
  return json as T;
}

/** Пресеты из рекомендаций Resemble: подача решается парой exaggeration + cfg_weight. */
const PRESETS = [
  { name: "по умолчанию", exaggeration: 0.5, cfg: 0.5, hint: "ровное чтение" },
  { name: "живее", exaggeration: 0.7, cfg: 0.3, hint: "для хука" },
  { name: "быстрый автор", exaggeration: 0.5, cfg: 0.3, hint: "если образец частит" },
  { name: "без переноса акцента", exaggeration: 0.5, cfg: 0.0, hint: "образец на другом языке" },
];

export default function TestPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [takes, setTakes] = useState<Take[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [language, setLanguage] = useState("ru");
  const [exaggeration, setExaggeration] = useState(0.5);
  const [cfg, setCfg] = useState(0.5);
  const [temperature, setTemperature] = useState(0.8);
  const [seed, setSeed] = useState("");
  const [note, setNote] = useState("");

  const [speaking, setSpeaking] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [refName, setRefName] = useState("");
  const [refSeconds, setRefSeconds] = useState(20);

  const refresh = useCallback(async () => {
    try {
      const [h, v, t] = await Promise.all([
        call<Health>("health"),
        call<{ voices: Voice[] }>("voices"),
        call<{ takes: Take[] }>("takes"),
      ]);
      setHealth(h);
      setVoices(v.voices);
      setTakes(t.takes);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // пока модель грузится или карта занята — обновляем состояние сами, чтобы не жать кнопку
  useEffect(() => {
    if (!health?.loading && !health?.busy) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [health?.loading, health?.busy, refresh]);

  async function model(action: "load" | "unload") {
    setModelBusy(true);
    setError(null);
    try {
      setHealth(await call<Health>(action, { method: "POST" }));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setModelBusy(false);
    }
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("name", refName || file.name.replace(/\.[^.]+$/, ""));
      form.set("seconds", String(refSeconds));
      const r = await call<{ voices: Voice[]; slug: string }>("voices", { method: "POST", body: form });
      setVoices(r.voices);
      setVoice(r.slug);
      setRefName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setUploading(false);
    }
  }

  async function removeVoice(slug: string) {
    try {
      const r = await call<{ voices: Voice[] }>(`voices/${slug}`, { method: "DELETE" });
      setVoices(r.voices);
      if (voice === slug) setVoice("");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function speak() {
    if (!text.trim()) return;
    setSpeaking(true);
    setError(null);
    try {
      const take = await call<Take>("speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          voice: voice || null,
          language_id: language,
          exaggeration,
          cfg_weight: cfg,
          temperature,
          seed: seed.trim() === "" ? null : Number(seed),
          note,
        }),
      });
      setTakes((prev) => [take, ...prev]);
      refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSpeaking(false);
    }
  }

  async function removeTake(id: string) {
    try {
      const r = await call<{ takes: Take[] }>(`takes/${id}`, { method: "DELETE" });
      setTakes(r.takes);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  const vram = health?.vram ?? {};
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Стенд озвучки</h1>
        <div className="page-sub">
          Chatterbox Multilingual V3 на своей видеокарте. Бесплатно и без лимитов, наружу ничего не уходит.
          Проверенная настройка потом переезжает в основной поток.
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Видеокарта</h2>
          <StatusBadge
            tone={health?.loaded ? "success" : "neutral"}
            busy={health?.loading || health?.busy}
          >
            {health?.loading ? "готовится" : health?.busy ? "считает" : health?.loaded ? "готова" : "свободна"}
          </StatusBadge>
        </div>
        {/* Кнопки «загрузить» тут нет намеренно: модель встаёт в память сама при первой
            озвучке. Единственное решение, которое принимает человек, — отдать карту Clipy. */}
        <div className="hint">
          {health?.loaded
            ? "Озвучка пойдёт сразу. Перед рендером в Clipy освободите карту."
            : "Первая озвучка займёт на полторы минуты больше: модель встанет в память."}
          {vram.usedMb ? ` Занято ${vram.usedMb} из ${vram.totalMb} МБ.` : ""}
        </div>
        {health && !health.cuda && (
          <div className="hint" style={{ color: "var(--error)", marginTop: 6 }}>
            Карта не видна контейнеру, синтез пойдёт на процессоре и будет очень медленным.
          </div>
        )}
        <div className="actions">
          <Button variant="secondary" onClick={() => model("unload")} busy={modelBusy} disabled={!health?.loaded}>
            Освободить карту
          </Button>
          <Button variant="ghost" onClick={refresh}>
            Обновить
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Образец голоса</h2>
          <span className="small muted">{voices.length} шт.</span>
        </div>
        <div className="hint">
          Chatterbox клонирует голос из короткого отрывка. Нужна чистая речь без музыки и обработки,
          10–20 секунд. Файл может быть любым, звук вытащим сами.
        </div>
        <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Файл">
            <input ref={fileRef} type="file" accept="audio/*,video/*" />
          </Field>
          <Field label="Имя">
            <input type="text" value={refName} onChange={(e) => setRefName(e.target.value)} placeholder="автор" />
          </Field>
          <Field label={`Секунд: ${refSeconds}`}>
            <input
              type="range"
              min={5}
              max={40}
              step={1}
              value={refSeconds}
              onChange={(e) => setRefSeconds(Number(e.target.value))}
            />
          </Field>
          <Button onClick={upload} busy={uploading}>
            Загрузить образец
          </Button>
        </div>

        {voices.length > 0 && (
          <div className="section">
            {voices.map((v) => (
              <div key={v.slug} className="row" style={{ gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                <label className="row" style={{ gap: 6, alignItems: "center" }}>
                  <input type="radio" name="voice" checked={voice === v.slug} onChange={() => setVoice(v.slug)} />
                  <b>{v.slug}</b>
                </label>
                <span className="small muted">
                  {v.seconds} с · {v.sizeKb} КБ
                </span>
                <audio controls preload="none" src={api(`voices/${v.slug}.wav`)} style={{ height: 32 }} />
                <Button variant="ghost" size="sm" onClick={() => removeVoice(v.slug)}>
                  Удалить
                </Button>
              </div>
            ))}
            <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 8 }}>
              <input type="radio" name="voice" checked={voice === ""} onChange={() => setVoice("")} />
              <span className="small muted">без образца — голос модели по умолчанию</span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Текст</h2>
          <span className="small muted">
            {text.length} знаков · {words} слов
          </span>
        </div>
        <textarea
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Вставьте сценарий целиком. Длинный текст режется по фразам и склеивается обратно."
        />

        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <Field label="Язык">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {["ru", "en", "de", "fr", "es", "it", "pl", "tr", "pt", "nl"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Экспрессия: ${exaggeration.toFixed(2)}`} note="выше — эмоциональнее и быстрее">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={exaggeration}
              onChange={(e) => setExaggeration(Number(e.target.value))}
            />
          </Field>
          <Field label={`CFG: ${cfg.toFixed(2)}`} note="ниже — медленнее и свободнее">
            <input type="range" min={0} max={1} step={0.05} value={cfg} onChange={(e) => setCfg(Number(e.target.value))} />
          </Field>
          <Field label={`Температура: ${temperature.toFixed(2)}`}>
            <input
              type="range"
              min={0.1}
              max={1.5}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
          </Field>
          <Field label="Seed" note="одно число — повторяемый дубль">
            <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="пусто" />
          </Field>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {PRESETS.map((p) => (
            <Button
              key={p.name}
              variant="secondary"
              size="sm"
              onClick={() => {
                setExaggeration(p.exaggeration);
                setCfg(p.cfg);
              }}
            >
              {p.name} · {p.hint}
            </Button>
          ))}
        </div>

        <div className="row" style={{ gap: 10, alignItems: "flex-end", marginTop: 12 }}>
          <Field label="Пометка к дублю">
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="что проверяем" />
          </Field>
          <Button onClick={speak} busy={speaking} disabled={!text.trim()}>
            Озвучить
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Дубли</h2>
          <span className="small muted">{takes.length} шт.</span>
        </div>
        {takes.length === 0 ? (
          <div className="hint">Пока пусто. Дубли остаются здесь, чтобы сравнивать настройки на слух, а не по памяти.</div>
        ) : (
          takes.map((t) => (
            <div key={t.id} className="section">
              <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <audio controls preload="none" src={api(`takes/${t.id}.wav`)} style={{ height: 34 }} />
                <span className="small muted">
                  {t.voice ?? "без образца"} · экспрессия {t.exaggeration} · CFG {t.cfg_weight} · темп {t.temperature}
                  {t.seed !== null ? ` · seed ${t.seed}` : ""}
                </span>
                <span className="small muted">
                  {t.seconds} с звука за {t.elapsedSec} с · {t.chars} знаков в {t.chunks} кусках
                </span>
                <a className="link-btn" href={api(`takes/${t.id}.wav`)} download>
                  Скачать
                </a>
                <Button variant="ghost" size="sm" onClick={() => removeTake(t.id)}>
                  Удалить
                </Button>
              </div>
              {t.note && <div className="small" style={{ marginTop: 4 }}>{t.note}</div>}
              <div className="small muted" style={{ marginTop: 4 }}>
                {t.text.slice(0, 160)}
                {t.text.length > 160 ? "…" : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
