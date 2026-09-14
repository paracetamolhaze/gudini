import { useState } from "react";
import { post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, ErrorBox, Notice } from "../ui";

type Prompt = { id: string; name: string; version: number; prompt: string; active: boolean; note: string | null; created_at: string };

export default function Prompts() {
  const { data, error, reload } = useFetch<{ prompts: Prompt[]; names: string[] }>("/prompts");
  const act = useAction();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const names = data?.names ?? [];
  const selected = name || names[0] || "";
  const versions = (data?.prompts ?? []).filter((p) => p.name === selected);
  const active = versions.find((v) => v.active);
  return (
    <>
      <Card title="Промпты" actions={<select value={selected} onChange={(e) => { setName(e.target.value); setText(""); }} style={{ width: 220 }}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>}>
        <p className="muted small">Production-промпт никогда не редактируется на месте: создаётся новая версия, затем активируется. Каждая публикация хранит имя и версию промпта.</p>
        <ErrorBox text={error} /><ErrorBox text={act.error} /><Notice text={act.notice} />
        {active && (
          <div className="stack">
            <div className="row"><Badge tone="success">активна v{active.version}</Badge><span className="dim small">{active.note}</span></div>
            <pre className="json" style={{ maxHeight: 360 }}>{active.prompt}</pre>
          </div>
        )}
      </Card>
      <Card title={`Новая версия ${selected}`}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={active ? "Скопируйте активную версию и измените нужное…" : ""} style={{ minHeight: 260 }} />
        <div className="row" style={{ marginTop: 8 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="заметка: что изменилось" style={{ width: 320 }} />
          <Button size="sm" onClick={() => setText(active?.prompt ?? "")}>Взять активную</Button>
          <Button tone="primary" disabled={text.trim().length < 20} onClick={() => void act.run("Создать версию", async () => { await post("/prompts", { name: selected, prompt: text, note: note || undefined }); setText(""); setNote(""); }, reload)}>Создать версию</Button>
        </div>
      </Card>
      <Card title="Версии">
        {versions.map((v) => (
          <div key={v.id} className="item">
            <div className="item-head">
              <div className="row"><Badge tone={v.active ? "success" : "neutral"}>v{v.version}{v.active ? " · активна" : ""}</Badge><span className="dim small">{fmtDate(v.created_at)} · {v.note}</span></div>
              {!v.active && <Button size="sm" onClick={() => { if (confirm(`Активировать ${v.name} v${v.version}?`)) void act.run("Активировать", () => post(`/prompts/${v.id}/activate`), reload); }}>Активировать</Button>}
            </div>
            <details><summary>текст</summary><pre className="json">{v.prompt}</pre></details>
          </div>
        ))}
      </Card>
    </>
  );
}
