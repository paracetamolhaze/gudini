import test from "node:test";
import assert from "node:assert/strict";
import { EXPLAINER_SYSTEM, isExplainerTopic } from "../lib/explainerScript";
import { scriptPrompt } from "../lib/ai";
import { researchFollowUps } from "../lib/storyResearch";
import { ensureParagraphs } from "../lib/scriptParagraphs";
import { CRYPTO_SERIES, seriesPosition } from "../lib/seriesPlan";

test("сценарист знает номер ролика в плане серии и следующий по плану", () => {
  assert.equal(CRYPTO_SERIES.length, 100);
  const pizza = "Пицца за 10 000 биткоинов: самый дорогой ужин в истории";
  assert.deepEqual(seriesPosition("Биткоин за минуту: объясняю так, чтобы понял младший брат"), { number: 1, total: 100, next: pizza });
  assert.equal(seriesPosition("Биткоин за минуту")?.number, 1);
  assert.equal(seriesPosition("Мой путь в крипту: с чего всё началось 🎙")?.number, 11);
  assert.equal(seriesPosition("Первая покупка крипты: 5 ошибок почти всех новичков (18+)")?.number, 85);
  assert.equal(seriesPosition("«Все уже заработали, а мне уже поздно»: почему так кажется каждый год")?.next, undefined);
  assert.equal(seriesPosition("Беспилотное такси Waymo: пассажиры, наблюдение и вызов полиции"), null);
  assert.match(scriptPrompt("Биткоин за минуту", null).user, /Следующий ролик серии: «Пицца за 10 000 биткоинов/);
  assert.doesNotMatch(scriptPrompt("Беспилотное такси Waymo: пассажиры, наблюдение и вызов полиции", null).user, /серии/);
});

test("сплошной сценарий делится на абзацы без потери слов, призыв — отдельным абзацем", () => {
  const solid = "Представь: ты отправляешь другу деньги, и никакого банка в этой истории нет вообще. Это биткоин. " +
    "Смотри, объясню как младшему брату. Представь общий чат, где сидят все на свете. Каждый перевод пишется туда сообщением. " +
    "Вот и весь биткоин: деньги, которые никто не может допечатать. Подпишись, дальше разберём блокчейн и кошельки.";
  const out = ensureParagraphs(solid);
  const paragraphs = out.split("\n\n");
  assert.ok(paragraphs.length >= 3);
  assert.equal(out.replace(/\s+/g, " "), solid);
  assert.match(paragraphs.at(-1)!, /^Подпишись, дальше разберём блокчейн и кошельки\.$/);
  const ready = "Хук.\n\nМысль один. Мысль два.\n\nПодпишись.";
  assert.equal(ensureParagraphs(ready), ready);
  assert.equal(ensureParagraphs("Коротко. Всего две фразы."), "Коротко. Всего две фразы.");
});

test("объяснение определяется по исследованию или по обещанию темы", () => {
  assert.equal(isExplainerTopic("Любая тема", { kind: "EXPLAINER" }), true);
  assert.equal(isExplainerTopic("Биткоин за минуту: объясняю так, чтобы понял младший брат"), true);
  assert.equal(isExplainerTopic("Что такое стейблкоины"), true);
  assert.equal(isExplainerTopic("Блокчейн простыми словами", { kind: "OTHER" }), true);
  assert.equal(isExplainerTopic("FTX: как биржа за 32 миллиарда долларов рухнула за неделю", { kind: "NEWS_EVENT" }), false);
  assert.equal(isExplainerTopic("Две лучшие камеры для путешествий"), false);
});

test("промпт объяснения учит приёмам: одна аналогия, мало терминов, уверенный голос, хук-сцена, серия", () => {
  assert.match(EXPLAINER_SYSTEM, /одну аналогию/);
  assert.match(EXPLAINER_SYSTEM, /одного-двух терминов/);
  assert.match(EXPLAINER_SYSTEM, /«смотри», «представь»/);
  assert.match(EXPLAINER_SYSTEM, /конкретная сцена из жизни зрителя/);
  assert.match(EXPLAINER_SYSTEM, /у каждого понятия свой ролик/);
  assert.match(EXPLAINER_SYSTEM, /главный герой ролика: назови его в первой фразе/);
  assert.ok(!/тезис автора|противоречащие данные|Справка/i.test(EXPLAINER_SYSTEM));
});

test("объяснению не нужен второй круг поиска, выбору и новостям он остаётся", () => {
  const followUpQueries = ["Bitcoin full node validation rules", "Camera A battery life"];
  assert.deepEqual(researchFollowUps("Биткоин за минуту", { kind: "EXPLAINER", followUpQueries }), []);
  assert.deepEqual(researchFollowUps("Блокчейн простыми словами", { kind: "OTHER", followUpQueries }), []);
  assert.deepEqual(researchFollowUps("Две лучшие камеры для путешествий", { kind: "PRODUCT", followUpQueries }), followUpQueries);
  assert.deepEqual(researchFollowUps("FTX: как рухнула биржа", null), []);
});

test("объяснение пишется от темы: факты и записка исследования в сценарий не попадают", () => {
  const research = {
    kind: "EXPLAINER", status: "UNKNOWN", editorialBrief: "Тезис: майнинг, nonce, пулы",
    facts: [{ id: "f1", text: "Майнинговое оборудование перебирает nonce", sourceUrls: ["https://developer.bitcoin.org"] }],
  } as any;
  const { system, user } = scriptPrompt("Биткоин за минуту", research, "Темп речи автора 150 слов в минуту");
  assert.equal(system, EXPLAINER_SYSTEM);
  assert.match(user, /Темп речи автора 150/);
  assert.match(user, /ролика-объяснения на тему: «Биткоин за минуту»/);
  assert.ok(!/nonce|Тезис|Статус на сегодня|Редакторская проверка|Справка/.test(user));
});

test("новости и выбор по-прежнему идут по общему промпту с запиской исследования", () => {
  const research = {
    kind: "NEWS_EVENT", status: "PAST", editorialBrief: "Рассказать, как рухнула биржа",
    facts: [{ id: "f1", text: "Биржа остановила вывод средств", sourceUrls: ["https://example.com"] }],
  } as any;
  const { system, user } = scriptPrompt("FTX: как биржа рухнула за неделю", research);
  assert.notEqual(system, EXPLAINER_SYSTEM);
  assert.match(user, /Рассказать, как рухнула биржа/);
  assert.match(user, /сценарий видео на тему/);
});
