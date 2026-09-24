import test from "node:test";
import assert from "node:assert/strict";
import { EXPLAINER_SYSTEM, explainerBrief, isExplainerTopic } from "../lib/explainerScript";
import { scriptPrompt } from "../lib/ai";
import { researchFollowUps } from "../lib/storyResearch";

test("объяснение определяется по исследованию или по обещанию темы", () => {
  assert.equal(isExplainerTopic("Любая тема", { kind: "EXPLAINER" }), true);
  assert.equal(isExplainerTopic("Биткоин за минуту: объясняю так, чтобы понял младший брат"), true);
  assert.equal(isExplainerTopic("Что такое стейблкоины"), true);
  assert.equal(isExplainerTopic("Блокчейн простыми словами", { kind: "OTHER" }), true);
  assert.equal(isExplainerTopic("FTX: как биржа за 32 миллиарда долларов рухнула за неделю", { kind: "NEWS_EVENT" }), false);
  assert.equal(isExplainerTopic("Две лучшие камеры для путешествий"), false);
});

test("в справку объяснения идут только факты, без записки исследования и ссылок", () => {
  assert.equal(explainerBrief(null), "");
  const brief = explainerBrief({
    facts: [{ id: "f1", text: "Биткоинов будет не больше 21 миллиона", sourceUrls: ["https://example.com"] }],
    editorialBrief: "Тезис: три опоры",
  } as any);
  assert.match(brief, /- Биткоинов будет не больше 21 миллиона/);
  assert.match(brief, /Справка для проверки точности/);
  assert.ok(!/Тезис: три опоры|https/.test(brief));
});

test("промпт объяснения учит приёмам: одна аналогия, мало терминов, уверенный голос, хук-сцена", () => {
  assert.match(EXPLAINER_SYSTEM, /одну аналогию/);
  assert.match(EXPLAINER_SYSTEM, /одного-двух терминов/);
  assert.match(EXPLAINER_SYSTEM, /«смотри», «представь»/);
  assert.match(EXPLAINER_SYSTEM, /конкретная сцена из жизни зрителя/);
  assert.ok(!/тезис автора|противоречащие данные/i.test(EXPLAINER_SYSTEM));
});

test("объяснению не нужен второй круг поиска, выбору и новостям он остаётся", () => {
  const followUpQueries = ["Bitcoin full node validation rules", "Camera A battery life"];
  assert.deepEqual(researchFollowUps("Биткоин за минуту", { kind: "EXPLAINER", followUpQueries }), []);
  assert.deepEqual(researchFollowUps("Блокчейн простыми словами", { kind: "OTHER", followUpQueries }), []);
  assert.deepEqual(researchFollowUps("Две лучшие камеры для путешествий", { kind: "PRODUCT", followUpQueries }), followUpQueries);
  assert.deepEqual(researchFollowUps("FTX: как рухнула биржа", null), []);
});

test("сценарист объяснения получает свой промпт и справку без записки исследования", () => {
  const research = {
    kind: "EXPLAINER", status: "UNKNOWN", editorialBrief: "Тезис: полные узлы, выходы, ключи",
    facts: [{ id: "f1", text: "Каждый полный узел хранит проверенную цепочку", sourceUrls: ["https://example.com"] }],
  } as any;
  const { system, user } = scriptPrompt("Биткоин за минуту", research, "Темп речи автора 150 слов в минуту");
  assert.equal(system, EXPLAINER_SYSTEM);
  assert.match(user, /Темп речи автора 150/);
  assert.match(user, /Каждый полный узел хранит проверенную цепочку/);
  assert.match(user, /ролика-объяснения на тему: «Биткоин за минуту»/);
  assert.ok(!/Тезис: полные узлы|Статус на сегодня|Редакторская проверка/.test(user));
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
