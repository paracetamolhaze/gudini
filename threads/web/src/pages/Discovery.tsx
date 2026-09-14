import { useEffect, useState } from "react";
import { post, put } from "../api";
import { useAction, useFetch, fmtDate } from "../hooks";
import { Badge, Button, Card, Empty, ErrorBox, Notice, Status } from "../ui";

type Post = { id: string; threads_post_id: string; username: string; text: string; keyword: string | null; total_score: number | null; status: string; reason: string | null; interaction_id: string | null; published_at: string | null; created_at: string; scores_json: { relevance?: number; valueAdd?: number; spamRisk?: number; angle?: string } | null };
type SettingsData = { settings: { engagement: { watchKeywords: string[]; minimumScore: number; pollMinutes: number } } };

export default function Discovery({ navigate }: { navigate: (p: string) => void }) {
  const posts = useFetch<{ posts: Post[] }>("/discovery", { intervalMs: 20_000 });
  const settings = useFetch<SettingsData>("/settings");
  const act = useAction();
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKw, setNewKw] = useState("");
  useEffect(() => {
    if (settings.data) setKeywords(settings.data.settings.engagement.watchKeywords);
  }, [settings.data]);
  const save = (next: string[]) => {
    setKeywords(next);
    void act.run("Сохранить ключевые слова", () => put("/settings", { engagement: { watchKeywords: next } }), settings.reload);
  };
  return (
    <>
      <Card title="Ключевые слова для поиска" actions={<Button size="sm" onClick={() => void act.run("Запустить поиск", () => post("/discovery/run"), posts.reload)}>Искать сейчас</Button>}>
        <div className="pill-list">
          {keywords.map((k) => <span key={k} className="pill">{k}<button onClick={() => save(keywords.filter((x) => x !== k))}>×</button></span>)}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input value={newKw} onChange={(e) => setNewKw(e.target.value)} placeholder="новое слово" style={{ width: 220 }} onKeyDown={(e) => { if (e.key === "Enter" && newKw.trim()) { save([...keywords, newKw.trim()]); setNewKw(""); } }} />
          <Button size="sm" onClick={() => { if (newKw.trim()) { save([...keywords, newKw.trim()]); setNewKw(""); } }}>Добавить</Button>
          {settings.data && <span className="dim small">порог {settings.data.settings.engagement.minimumScore}, каждые {settings.data.settings.engagement.pollMinutes} мин</span>}
        </div>
        <ErrorBox text={act.error} />
        <Notice text={act.notice} />
      </Card>
      <Card title="Найденные посты">
        <ErrorBox text={posts.error} />
        {posts.data && posts.data.posts.length === 0 && <Empty title="Пока ничего не найдено" text="Нужен токен с threads_keyword_search; без Advanced Access поиск ограничен своими постами." />}
        {posts.data?.posts.map((p) => (
          <div key={p.id} className="item">
            <div className="item-head">
              <div><span className="item-title">@{p.username}</span> <Status value={p.status} /> {p.keyword && <Badge>{p.keyword}</Badge>} {p.total_score !== null && <Badge tone={p.total_score >= 70 ? "success" : "neutral"}>балл {p.total_score}</Badge>}
                <div className="item-meta"><span>{fmtDate(p.published_at ?? p.created_at)}</span>{p.scores_json?.valueAdd !== undefined && <span>value {p.scores_json.valueAdd} · spam {p.scores_json.spamRisk}</span>}</div>
              </div>
              {p.interaction_id && <Button size="sm" onClick={() => navigate(`replies/${p.interaction_id}`)}>К ответу</Button>}
            </div>
            <div className="quote small">{p.text.slice(0, 500)}</div>
            {p.reason && <div className="small dim" style={{ marginTop: 4 }}>{p.reason}</div>}
          </div>
        ))}
      </Card>
    </>
  );
}
