import fs from "node:fs";
import path from "node:path";

// Explicit opt-in: default replay is offline. No video/image provider is called by this script.
async function main() {
  const live = process.argv.includes("--live");
  if (live && fs.existsSync(".env")) process.loadEnvFile(".env");
  const { planFilm } = await import("../lib/aiFilm/run");
  const { mediaComplete } = await import("../lib/mediaLlm");
  const { STORY_MODEL } = await import("../lib/aiFilm/story");
  const { loadCharacterProfile } = await import("../lib/aiFilm/character");
  const { loadUniverseProfile } = await import("../lib/aiFilm/universe");
  const { gateIssues } = await import("../lib/aiFilm/criteria");
  const { resetLedger, setRunCostLimit, ledger } = await import("../lib/costLedger");
  const cases = [
    { id: "news", topic: "Учебная новость о возвращённом портфеле", facts: ["Посетитель оставил закрытый синий портфель на скамье. Сотрудница нашла его и передала владельцу. Как установили владельца, неизвестно."], sentences: ["В городском парке посетитель забыл синий портфель на скамье.", "Сотрудница парка заметила портфель и подняла его.", "Через некоторое время владелец вернулся за пропажей.", "Она передала ему портфель, и мужчина забрал его.", "Как сотрудники установили владельца, в сообщении не объясняют.", "Главное, что вещь вернулась к хозяину."] },
    { id: "history", topic: "Учебная историческая реконструкция переписки", facts: ["В реконструируемом эпизоде XIX века письмо запечатывают воском и передают курьеру. Содержание письма не известно."], sentences: ["В девятнадцатом веке это письмо отправляли с курьером.", "Женщина сложила написанный лист и вложила в конверт.", "Она капнула воск на клапан и прижала печать.", "Когда воск застыл, конверт перешёл в руки курьера.", "Он убрал письмо в кожаную сумку и вышел.", "Содержание письма нам неизвестно, виден только способ доставки."] },
    { id: "philosophy", topic: "Условная притча о выборе", facts: [], sentences: ["Представь человека у двух открытых дверей.", "За одной он видит знакомую комнату, за другой — сад.", "Он тянется к первой ручке, но останавливается.", "Затем поворачивается и проходит через дверь в сад.", "Выбор здесь не доказывает, что одна жизнь лучше другой.", "Притча только спрашивает, почему знакомое кажется безопаснее."] },
    { id: "explainer", topic: "Пример: клавиша и результат действия", facts: [], sentences: ["На столе стоит простая лампа с механическим выключателем.", "Пока выключатель отпущен, лампа не горит.", "Человек нажимает выключатель, и лампа загорается.", "Он убирает руку, но свет продолжает гореть.", "Теперь человек снова нажимает выключатель, и свет гаснет.", "Так мы отличаем само нажатие от состояния, которое оно изменило."] },
  ];
  const selected = process.argv.find(a => a.startsWith("--cases="))?.split("=")[1]?.split(",");
  const root = path.resolve(process.argv.find(a => a.startsWith("--output="))?.slice(9) ?? "data/planner-autonomy");
  const firstFrom = process.argv.find(a => a.startsWith("--first-from="))?.slice(13);
  fs.mkdirSync(root, { recursive: true });
  resetLedger(); setRunCostLimit(Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? 1));
  const character = loadCharacterProfile(), universe = loadUniverseProfile();
  const summary: unknown[] = [];
  for (const item of cases.filter(c => !selected || selected.includes(c.id))) {
    const dir = path.join(root, item.id); fs.mkdirSync(dir, { recursive: true });
    const words = item.sentences.flatMap((s, n) => { const parts = s.split(" "); return parts.map((word, i) => ({ word, start: n * 6 + i * 6 / parts.length, end: n * 6 + (i + 1) * 6 / parts.length - 0.03 })); });
    let calls = 0;
    try {
      const result = await planFilm({ words, duration: 36, script: item.sentences.join("\n"), topic: item.topic,
        skipEditorialReview: !live,
        researchFacts: item.facts, character, universe, coverage: { target: 0.5, max: 0.8 },
        cfg: { key: `autonomy-${item.id}`, universe, budgetUsd: 4, maxCoverage: 0.8, concurrency: 1, callMinutes: 2 },
        complete: async ({ system, user, retry }) => {
          if (++calls > 2) throw new Error("More than two planner calls");
          const prefix = path.join(dir, `call-${calls}`);
          if (!live) return fs.readFileSync(`${prefix}-raw.json`, "utf8");
          if (firstFrom && calls === 1) {
            for (const suffix of ["raw.json", "system.txt", "user.txt"]) {
              fs.copyFileSync(path.join(firstFrom, item.id, `call-1-${suffix}`), `${prefix}-${suffix}`);
            }
            return fs.readFileSync(`${prefix}-raw.json`, "utf8");
          }
          fs.writeFileSync(`${prefix}-system.txt`, system); fs.writeFileSync(`${prefix}-user.txt`, user);
          const raw = await mediaComplete({ model: STORY_MODEL, maxTokens: 16000, stage: "AI Film Story", reasoning: "off", system, user });
          fs.writeFileSync(`${prefix}-raw.json`, raw); return raw;
        },
      });
      fs.writeFileSync(path.join(dir, live ? "result.json" : "replay.json"), JSON.stringify(result, null, 2));
      const row = { id: item.id, calls, reusedFirst: Boolean(firstFrom), accepted: result.accepted, scenes: result.plan.shots.length, blocks: gateIssues(result.plan).map((i) => i.code), warnings: result.plan.issues.filter((i) => i.severity !== "block").map((i) => i.code) };
      if (row.blocks.length) process.exitCode = 1;
      summary.push(row); console.log(JSON.stringify(row));
    } catch (error) { process.exitCode = 1; const row = { id: item.id, calls, error: error instanceof Error ? error.message : String(error) }; summary.push(row); console.log(JSON.stringify(row)); }
    fs.writeFileSync(path.join(root, live ? "summary.json" : "replay-summary.json"), JSON.stringify({ summary, ledger: ledger(), cost: ledger().reduce((a, e) => a + e.estimatedCost, 0) }, null, 2));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
