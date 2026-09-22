import { useEffect, useState } from "react";
import { put } from "../api";
import { useAction, useFetch } from "../hooks";
import { Badge, Button, Card, ErrorBox, Field, Notice, Toggle } from "../ui";

type Settings = {
  mode: "OFF" | "DRAFT" | "REVIEW" | "AUTO";
  killSwitch: boolean;
  dryRun: boolean;
  flags: { autoPost: boolean; autoOwnReplies: boolean; autoPublicReplies: boolean; imageTranslation: boolean };
  models: { analysis: string; writer: string; reply: string; vision: string; translation: string; embedding: string };
  scoring: { minimumContentScore: number; weights: { relevance: number; freshness: number; sourcePriority: number; novelty: number; value: number }; autoPublish: { maxRisk: number; minConfidence: number; minScore: number } };
  dedup: { similarityThreshold: number; windowHours: number };
  schedule: { minimumMinutesBetweenPosts: number; maximumPostsPerDay: number; preferredHours: number[]; timezone: string };
  limits: { maxPublicRepliesPerHour: number; maxPublicRepliesPerDay: number; maxOwnRepliesPerHour: number; maxOwnRepliesPerDay: number; maxPostsPerDay: number };
  sources: { defaultPollMinutes: number; searchPollMinutes: number; searchKeywords: string[]; profileFallbackKeywords: string[] };
  engagement: { watchKeywords: string[]; minimumScore: number; pollMinutes: number };
  replies: { pollMinutes: number; lookbackHours: number; maxUnansweredPerPost: number; minConfidence: number };
  images: { retries: number; minFontPx: number; maxImagesPerPost: number };
  expiry: { breakingHours: number; normalHours: number; evergreenHours: number };
  writer: { variantsPerDraft: number; maxStyleExamples: number; language: string };
  analytics: { insightsPollMinutes: number; snapshotDays: number };
  pricing: Record<string, { input: number; output: number }>;
};
type Data = { settings: Settings; env: { threadsToken: boolean; llmProvider: string; keys: Record<string, boolean>; sitePasswordSet: boolean; publicBaseUrl: string | null } };

const num = (v: string) => (v === "" ? 0 : Number(v));

/**
 * Числовое поле. Объявлено на уровне модуля не случайно: компонент, созданный внутри страницы,
 * при каждом рендере считается новым типом — React выбрасывает старый input вместе с фокусом,
 * и набрать «85» становится невозможно (после «8» курсор выпадает).
 */
function N({ label, value, onChange, note }: { label: string; value: number; onChange: (v: number) => void; note?: string }) {
  return (
    <Field label={label} note={note}>
      <input type="number" value={value} onChange={(e) => onChange(num(e.target.value))} />
    </Field>
  );
}

export default function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const { data, error, reload } = useFetch<Data>("/settings");
  const act = useAction();
  const [s, setS] = useState<Settings | null>(null);
  const [pricing, setPricing] = useState("");
  useEffect(() => {
    if (data) {
      setS(data.settings);
      setPricing(JSON.stringify(data.settings.pricing, null, 2));
    }
  }, [data]);
  if (error && !data) return <ErrorBox text={error} />;
  if (!s || !data) return <div className="muted">Загрузка…</div>;
  const set = <K extends keyof Settings>(key: K, patch: Partial<Settings[K]>) => setS({ ...s, [key]: { ...(s[key] as object), ...patch } as Settings[K] });
  const save = () =>
    void act.run("Сохранить настройки", async () => {
      let parsedPricing: unknown;
      try {
        parsedPricing = JSON.parse(pricing);
      } catch {
        throw new Error("pricing: невалидный JSON");
      }
      await put("/settings", { ...s, pricing: parsedPricing });
    }, async () => { await reload(); onSaved(); });
  return (
    <>
      <div className="row row-between" style={{ marginBottom: 10 }}>
        <div className="row small">
          <Badge tone={data.env.threadsToken ? "success" : "error"}>THREADS_ACCESS_TOKEN {data.env.threadsToken ? "задан" : "нет"}</Badge>
          <Badge>провайдер {data.env.llmProvider}</Badge>
          {Object.entries(data.env.keys).map(([k, v]) => <Badge key={k} tone={v ? "success" : "neutral"}>{k}: {v ? "ключ есть" : "нет"}</Badge>)}
          <Badge tone={data.env.publicBaseUrl ? "success" : "warn"}>PUBLIC_BASE_URL {data.env.publicBaseUrl ?? "не задан (картинки не уйдут)"}</Badge>
        </div>
        <Button tone="primary" busy={act.busy !== null} onClick={save}>Сохранить</Button>
      </div>
      <ErrorBox text={act.error} /><Notice text={act.notice} />
      <div className="grid grid-2">
        <Card title="Режим и предохранители">
          <Field label="Режим автопилота" note="OFF — ничего; DRAFT — только черновики; REVIEW — черновики на одобрение; AUTO — уверенный контент публикуется сам">
            <select value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value as Settings["mode"] })}>{["OFF", "DRAFT", "REVIEW", "AUTO"].map((m) => <option key={m}>{m}</option>)}</select>
          </Field>
          <div className="stack" style={{ marginTop: 10 }}>
            <Toggle checked={s.dryRun} onChange={(v) => setS({ ...s, dryRun: v })} label="DRY_RUN — читать Threads, но не публиковать (запись в лог)" />
            <Toggle checked={s.flags.autoPost} onChange={(v) => set("flags", { autoPost: v })} label="AUTO_POST_ENABLED — автопубликация в режиме AUTO" />
            <Toggle checked={s.flags.autoOwnReplies} onChange={(v) => set("flags", { autoOwnReplies: v })} label="AUTO_OWN_REPLIES — автоответы под нашими постами" />
            <Toggle checked={s.flags.autoPublicReplies} onChange={(v) => set("flags", { autoPublicReplies: v })} label="AUTO_PUBLIC_REPLIES — автоответы на чужие посты" />
            <Toggle checked={s.flags.imageTranslation} onChange={(v) => set("flags", { imageTranslation: v })} label="IMAGE_TRANSLATION_ENABLED — перевод картинок" />
          </div>
        </Card>
        <Card title="Модели (provider:model)">
          <div className="form-grid">
            {(["analysis", "writer", "reply", "vision", "translation", "embedding"] as const).map((k) => (
              <Field key={k} label={`${k}Model`} note={k === "embedding" ? "пусто — без эмбеддингов" : undefined}><input value={s.models[k]} onChange={(e) => set("models", { [k]: e.target.value } as Partial<Settings["models"]>)} placeholder="openrouter:anthropic/claude-sonnet-5" /></Field>
            ))}
          </div>
        </Card>
        <Card title="Скоринг и порог AUTO">
          <div className="form-grid">
            <N label="minimumContentScore" value={s.scoring.minimumContentScore} onChange={(v) => set("scoring", { minimumContentScore: v })} />
            <N label="AUTO: maxRisk (<)" value={s.scoring.autoPublish.maxRisk} onChange={(v) => set("scoring", { autoPublish: { ...s.scoring.autoPublish, maxRisk: v } })} />
            <N label="AUTO: minConfidence (>)" value={s.scoring.autoPublish.minConfidence} onChange={(v) => set("scoring", { autoPublish: { ...s.scoring.autoPublish, minConfidence: v } })} />
            <N label="AUTO: minScore (>)" value={s.scoring.autoPublish.minScore} onChange={(v) => set("scoring", { autoPublish: { ...s.scoring.autoPublish, minScore: v } })} />
            {(["relevance", "freshness", "sourcePriority", "novelty", "value"] as const).map((k) => <N key={k} label={`вес ${k}`} value={s.scoring.weights[k]} onChange={(v) => set("scoring", { weights: { ...s.scoring.weights, [k]: v } })} />)}
            <N label="dedup similarityThreshold (0–1)" value={s.dedup.similarityThreshold} onChange={(v) => set("dedup", { similarityThreshold: v })} />
            <N label="dedup windowHours" value={s.dedup.windowHours} onChange={(v) => set("dedup", { windowHours: v })} />
          </div>
        </Card>
        <Card title="Расписание и лимиты">
          <div className="form-grid">
            <N label="minimumMinutesBetweenPosts" value={s.schedule.minimumMinutesBetweenPosts} onChange={(v) => set("schedule", { minimumMinutesBetweenPosts: v })} />
            <N label="maximumPostsPerDay" value={s.schedule.maximumPostsPerDay} onChange={(v) => set("schedule", { maximumPostsPerDay: v })} />
            <Field label="preferredHours" note="через запятую, 0–23"><input value={s.schedule.preferredHours.join(",")} onChange={(e) => set("schedule", { preferredHours: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 0 && x <= 23) })} /></Field>
            <Field label="timezone"><input value={s.schedule.timezone} onChange={(e) => set("schedule", { timezone: e.target.value })} /></Field>
            <N label="maxPostsPerDay (hard cap)" value={s.limits.maxPostsPerDay} onChange={(v) => set("limits", { maxPostsPerDay: v })} />
            <N label="maxOwnRepliesPerHour" value={s.limits.maxOwnRepliesPerHour} onChange={(v) => set("limits", { maxOwnRepliesPerHour: v })} />
            <N label="maxOwnRepliesPerDay" value={s.limits.maxOwnRepliesPerDay} onChange={(v) => set("limits", { maxOwnRepliesPerDay: v })} />
            <N label="maxPublicRepliesPerHour" value={s.limits.maxPublicRepliesPerHour} onChange={(v) => set("limits", { maxPublicRepliesPerHour: v })} />
            <N label="maxPublicRepliesPerDay" value={s.limits.maxPublicRepliesPerDay} onChange={(v) => set("limits", { maxPublicRepliesPerDay: v })} />
          </div>
        </Card>
        <Card title="Источники, ответы, engagement">
          <div className="form-grid">
            <N label="sources.defaultPollMinutes" value={s.sources.defaultPollMinutes} onChange={(v) => set("sources", { defaultPollMinutes: v })} />
            <Field label="profileFallbackKeywords" note="для профилей без threads_profile_discovery"><input value={s.sources.profileFallbackKeywords.join(", ")} onChange={(e) => set("sources", { profileFallbackKeywords: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
            <N label="replies.pollMinutes" value={s.replies.pollMinutes} onChange={(v) => set("replies", { pollMinutes: v })} />
            <N label="replies.lookbackHours" value={s.replies.lookbackHours} onChange={(v) => set("replies", { lookbackHours: v })} />
            <N label="replies.maxUnansweredPerPost" value={s.replies.maxUnansweredPerPost} onChange={(v) => set("replies", { maxUnansweredPerPost: v })} />
            <N label="replies.minConfidence (AUTO)" value={s.replies.minConfidence} onChange={(v) => set("replies", { minConfidence: v })} />
            <N label="engagement.minimumScore" value={s.engagement.minimumScore} onChange={(v) => set("engagement", { minimumScore: v })} />
            <N label="engagement.pollMinutes" value={s.engagement.pollMinutes} onChange={(v) => set("engagement", { pollMinutes: v })} />
          </div>
        </Card>
        <Card title="Writer, картинки, сроки, аналитика">
          <div className="form-grid">
            <N label="writer.variantsPerDraft (1–3)" value={s.writer.variantsPerDraft} onChange={(v) => set("writer", { variantsPerDraft: v })} />
            <N label="writer.maxStyleExamples" value={s.writer.maxStyleExamples} onChange={(v) => set("writer", { maxStyleExamples: v })} />
            <N label="images.retries" value={s.images.retries} onChange={(v) => set("images", { retries: v })} />
            <N label="images.minFontPx" value={s.images.minFontPx} onChange={(v) => set("images", { minFontPx: v })} />
            <N label="expiry.breakingHours" value={s.expiry.breakingHours} onChange={(v) => set("expiry", { breakingHours: v })} />
            <N label="expiry.normalHours" value={s.expiry.normalHours} onChange={(v) => set("expiry", { normalHours: v })} />
            <N label="expiry.evergreenHours" value={s.expiry.evergreenHours} onChange={(v) => set("expiry", { evergreenHours: v })} />
            <N label="analytics.insightsPollMinutes" value={s.analytics.insightsPollMinutes} onChange={(v) => set("analytics", { insightsPollMinutes: v })} />
          </div>
        </Card>
      </div>
      <Card title="Тарифы моделей (USD за 1M токенов)">
        <textarea value={pricing} onChange={(e) => setPricing(e.target.value)} className="mono" style={{ minHeight: 160 }} />
        <div className="dim small">Ключ — подстрока id модели. OpenRouter возвращает точную стоимость сам; таблица нужна для остальных провайдеров.</div>
      </Card>
      <div className="row"><Button tone="primary" busy={act.busy !== null} onClick={save}>Сохранить</Button></div>
    </>
  );
}
