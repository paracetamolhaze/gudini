import { useState } from "react";
import { del, patch, post } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Notice } from "../ui";

type Example = { id: string; text: string; rating: number; source: string; enabled: boolean; tags: string[]; created_at: string };

export default function Voice() {
  const { data, error, reload } = useFetch<{ examples: Example[] }>("/voice/examples");
  const act = useAction();
  const [text, setText] = useState("");
  const [rating, setRating] = useState(4);
  const [tags, setTags] = useState("");
  return (
    <>
      <Card title="Голос аккаунта" actions={<Button size="sm" onClick={() => void act.run("Импорт из Threads", () => post("/voice/import", { count: 30 }), reload)}>Импортировать свои посты</Button>}>
        <p className="muted small">Примеры хороших постов (20–100). Writer получает несколько самых подходящих по теме, не все сразу. Лайкнутые черновики добавляются сюда автоматически.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Пример поста в нужном тоне…" />
        <div className="row" style={{ marginTop: 8 }}>
          <select value={rating} onChange={(e) => setRating(Number(e.target.value))} style={{ width: 120 }}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>оценка {n}</option>)}</select>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="теги через запятую (bitcoin, defi)" style={{ width: 260 }} />
          <Button tone="primary" disabled={text.trim().length < 10} onClick={() => void act.run("Добавить пример", async () => { await post("/voice/examples", { text, rating, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }); setText(""); setTags(""); }, reload)}>Добавить</Button>
        </div>
        <ErrorBox text={act.error} /><Notice text={act.notice} />
      </Card>
      <Card title={`Примеры (${data?.examples.length ?? 0})`}>
        <ErrorBox text={error} />
        {data && data.examples.length === 0 && <Empty title="Примеров пока нет" />}
        {data?.examples.map((e) => (
          <div key={e.id} className="item" style={{ opacity: e.enabled ? 1 : 0.55 }}>
            <div className="item-head">
              <div className="row"><Badge>{e.source}</Badge><Badge tone="accent">★ {e.rating}</Badge>{e.tags.map((t) => <Badge key={t}>{t}</Badge>)}<span className="dim small">{fmtDate(e.created_at)}</span></div>
              <div className="row">
                <Button size="sm" onClick={() => void act.run(e.enabled ? "Выключить" : "Включить", () => patch(`/voice/examples/${e.id}`, { enabled: !e.enabled }), reload)}>{e.enabled ? "Выключить" : "Включить"}</Button>
                <Button size="sm" tone="danger" onClick={() => void act.run("Удалить", () => del(`/voice/examples/${e.id}`), reload)}>Удалить</Button>
              </div>
            </div>
            <div className="pre">{e.text}</div>
          </div>
        ))}
      </Card>
    </>
  );
}
