import { useFetch, useAction } from "../hooks";
import { put } from "../api";
import { Card, ErrorBox, Notice, Toggle } from "../ui";
type Data = { settings: { mode: string; dryRun: boolean; killSwitch: boolean; flags: { autoOwnReplies: boolean; autoPublicReplies: boolean; autoPost: boolean } } };
export default function SimpleSettings({ navigate, changed }: { navigate: (p: string) => void; changed: () => void }) {
  const data = useFetch<Data>("/settings");
  const act = useAction();
  const s = data.data?.settings;
  function toggle(flag: string, enabled: boolean) { void act.run("Настройки сохранены", () => put("/settings", { mode: "AUTO", flags: { [flag]: enabled } }), async () => { await data.reload(); changed(); }); }
  return <><ErrorBox text={data.error} /><ErrorBox text={act.error} /><Notice text={act.notice} />
    {s && <Card title="Автоматизация"><fieldset disabled={act.busy !== null} className="settings-fields"><Toggle checked={s.flags.autoOwnReplies} onChange={v => toggle("autoOwnReplies", v)} label="Автоматически отвечать под моими постами" /><p className="muted small">До 30 ответов в сутки. Пауза от 5 минут, не более двух ответов одному человеку в ветке за сутки.</p><Toggle checked={s.flags.autoPublicReplies} onChange={v => toggle("autoPublicReplies", v)} label="Автоматически комментировать чужие посты" /><p className="muted small">Только содержательные обсуждения крипты. До 6 комментариев в сутки, пауза от 30 минут. Один комментарий автору в сутки.</p><Toggle checked={s.flags.autoPost} onChange={v => toggle("autoPost", v)} label="Автоматически публиковать найденные новости" /><p className="muted small">Если выключено, новые посты остаются черновиками. Посты по вашей теме публикуются после вашей команды.</p></fieldset>{s.dryRun && <p className="muted">Включён пробный запуск: отправки в Threads не происходят.</p>}</Card>}
    <Card title="Содержание"><div className="settings-links"><button onClick={() => navigate("voice")}>Стиль постов и ответов →</button><button onClick={() => navigate("sources")}>Источники криптоновостей →</button></div></Card>
    <details className="tech"><summary>Подключение и диагностика</summary><div className="settings-links"><button onClick={() => navigate("overview")}>Состояние подключения →</button><button onClick={() => navigate("advanced")}>Расширенные настройки →</button><button onClick={() => navigate("logs")}>История действий →</button></div></details>
  </>;
}
