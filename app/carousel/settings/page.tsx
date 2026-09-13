"use client";

import { useEffect, useRef, useState } from "react";
import { BackLink, Button, Field } from "../../components/ui";
import { DESIGN_LIMITS } from "@/lib/carousel/designShared";
import { AccessNotice, api, ApiError, isAccessError, type SectionStatus } from "../shared";
import s from "../carousel.module.css";

type Design = SectionStatus["design"];

/** Оформление аккаунта: задаётся один раз и применяется ко всем новым каруселям с иллюстрациями. */
export default function CarouselSettingsPage() {
  const [design, setDesign] = useState<Design | null>(null);
  const [draft, setDraft] = useState<Design | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ design: Design }>("/api/carousel/design")
      .then((r) => {
        setDesign(r.design);
        setDraft(r.design);
      })
      .catch((e) => setError(e));
  }, []);

  const dirty = design && draft && JSON.stringify(design) !== JSON.stringify(draft);

  async function run(name: string, fn: () => Promise<{ design: Design }>) {
    setBusy(name);
    setError(null);
    setSaved(false);
    try {
      const r = await fn();
      setDesign(r.design);
      setDraft(r.design);
      setSaved(true);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy("");
    }
  }

  const save = () =>
    run("save", () =>
      api("/api/carousel/design", {
        method: "PATCH",
        json: { accent: draft!.accent, textColor: draft!.textColor, scrimColor: draft!.scrimColor, titleFont: draft!.titleFont, author: draft!.author, illustrationStyle: draft!.illustrationStyle },
      }),
    );

  function upload(kind: "logo" | "reference", file: File | undefined) {
    if (!file) return;
    const max = kind === "logo" ? DESIGN_LIMITS.logoMaxBytes : DESIGN_LIMITS.referenceMaxBytes;
    if (file.size > max) {
      setError(new ApiError(`Файл больше ${Math.round(max / 1024 / 1024)} МБ`, 413));
      return;
    }
    const form = new FormData();
    form.append("file", file);
    void run(kind, () => api(`/api/carousel/design/asset?kind=${kind}`, { method: "POST", form }));
  }

  if (error && isAccessError(error)) {
    return (
      <main>
        <BackLink href="/carousel">Карусели</BackLink>
        <AccessNotice error={error} />
      </main>
    );
  }

  return (
    <main>
      <BackLink href="/carousel">Карусели</BackLink>
      <div className="page-head">
        <div>
          <h1 className="page-title">Оформление каруселей</h1>
          <p className={s.lead}>Настраивается один раз и применяется ко всем новым каруселям. Уже созданные карусели хранят свою копию — в редакторе есть кнопка «Применить текущее оформление».</p>
        </div>
      </div>

      {!draft ? (
        <div className="skeleton" style={{ height: 320 }} />
      ) : (
        <>
          <div className="card">
            <h2>Цвета и шрифт</h2>
            <div className={s.formGrid}>
              {(
                [
                  ["accent", "Акцент", "Выделение в заголовке, кнопка призыва, маркеры"],
                  ["textColor", "Цвет текста", "Текст поверх иллюстрации"],
                  ["scrimColor", "Цвет затемнения", "Подложка под текстом поверх картинки"],
                ] as const
              ).map(([key, label, note]) => (
                <Field key={key} label={label} note={note}>
                  <div className={s.colorRow}>
                    <input type="color" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value.toUpperCase() })} aria-label={label} />
                    <input type="text" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} maxLength={7} />
                  </div>
                </Field>
              ))}
            </div>
            <Field label="Шрифт заголовков">
              <select value={draft.titleFont} onChange={(e) => setDraft({ ...draft, titleFont: e.target.value as Design["titleFont"] })}>
                <option value="display">Крупный жирный (Montserrat)</option>
                <option value="condensed">Узкий заглавными (Oswald)</option>
              </select>
            </Field>
            <div className={s.previewStrip} style={{ background: draft.scrimColor, color: draft.textColor }}>
              <span style={{ fontFamily: draft.titleFont === "condensed" ? "Oswald, Impact, sans-serif" : "Montserrat, Arial Black, sans-serif", textTransform: draft.titleFont === "condensed" ? "uppercase" : "none" }}>
                Как <span style={{ color: draft.accent }}>высыпаться</span> за семь часов
              </span>
              <span className={s.previewCta} style={{ background: draft.accent }}>
                Сохрани
              </span>
            </div>
          </div>

          <div className="card">
            <h2>Подпись автора и логотип</h2>
            <Field label="Подпись внизу карточек" note="Например, @ваш_аккаунт. Пусто — без подписи. Если загружен логотип, показывается он.">
              <input type="text" value={draft.author} maxLength={DESIGN_LIMITS.authorMax} onChange={(e) => setDraft({ ...draft, author: e.target.value })} />
            </Field>
            <div className={s.assetRow}>
              {draft.logoFile ? <img className={s.assetPreview} src={`/api/carousel/design/file/${draft.logoFile}`} alt="Логотип" /> : <div className={`${s.assetPreview} ${s.assetEmpty}`}>Нет логотипа</div>}
              <div className={s.inline}>
                <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload("logo", e.target.files?.[0])} />
                <Button variant="secondary" size="sm" onClick={() => logoInput.current?.click()} busy={busy === "logo"}>
                  Загрузить логотип
                </Button>
                {draft.logoFile && (
                  <Button variant="ghost" size="sm" onClick={() => void run("logo-del", () => api("/api/carousel/design/asset?kind=logo", { method: "DELETE" }))}>
                    Убрать
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Иллюстрации</h2>
            <Field label="Предпочтительный стиль иллюстраций" note="Своими словами: техника, настроение, что любите и чего избегать. Claude учтёт это в визуальной концепции каждой карусели.">
              <textarea rows={3} value={draft.illustrationStyle} maxLength={DESIGN_LIMITS.styleMax} onChange={(e) => setDraft({ ...draft, illustrationStyle: e.target.value })} />
            </Field>
            <div className="field">
              <span>Визуальный референс (необязательно)</span>
              <div className="field-note">Картинка в желаемом стиле. Уходит генератору референсом стиля вместе с первой удачной иллюстрацией серии.</div>
            </div>
            <div className={s.assetRow}>
              {draft.referenceFile ? <img className={s.assetPreview} src={`/api/carousel/design/file/${draft.referenceFile}`} alt="Референс" /> : <div className={`${s.assetPreview} ${s.assetEmpty}`}>Нет референса</div>}
              <div className={s.inline}>
                <input ref={refInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload("reference", e.target.files?.[0])} />
                <Button variant="secondary" size="sm" onClick={() => refInput.current?.click()} busy={busy === "reference"}>
                  Загрузить референс
                </Button>
                {draft.referenceFile && (
                  <Button variant="ghost" size="sm" onClick={() => void run("ref-del", () => api("/api/carousel/design/asset?kind=reference", { method: "DELETE" }))}>
                    Убрать
                  </Button>
                )}
              </div>
            </div>
          </div>

          {error && <div className="error-box">{error.message}</div>}
          {saved && !dirty && <div className="success-box">Сохранено. Новые карусели будут оформлены так.</div>}
          <div className="actions">
            <Button onClick={() => void save()} busy={busy === "save"} disabled={!dirty}>
              Сохранить оформление
            </Button>
            <Button variant="ghost" onClick={() => setDraft(design)} disabled={!dirty}>
              Отменить
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
