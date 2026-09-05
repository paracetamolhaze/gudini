import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

/**
 * Изоляция провайдеров проверяется по исходникам всего репозитория, а не по
 * договорённости: правило имеет смысл, только если его нельзя обойти случайно.
 */

const libFiles = fs
  .readdirSync("lib")
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, src: fs.readFileSync(path.join("lib", f), "utf8") }));

const codeOf = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

test("1: OpenRouter достижим только из модулей обложки", () => {
  const offenders = libFiles
    .filter((f) => /openrouter\.ai|openrouterKey/i.test(codeOf(f.src)))
    .map((f) => f.name)
    // balances.ts — только чтение остатка лимита ключа для дашборда, генераций там нет;
    // mediaLlm.ts — единственный транспорт конвейера: Claude через OpenRouter включается
    // явно настройкой MEDIA_LLM_TRANSPORT, а не обстоятельствами
    .filter((n) => !/^cover/i.test(n) && n !== "store.ts" && n !== "pipeline.ts" && n !== "balances.ts" && n !== "mediaLlm.ts");
  assert.deepEqual(offenders, [], `OpenRouter вне обложек: ${offenders.join(", ")}`);

  // ни один медиа-модуль не должен даже знать адрес OpenRouter
  for (const n of ["storyAssetPack.ts", "brollRelevance.ts", "creativeDirector.ts", "scriptBeats.ts", "storyResearch.ts", "ai.ts"]) {
    const f = libFiles.find((x) => x.name === n);
    if (!f) continue;
    assert.ok(!/openrouter/i.test(codeOf(f.src)), `${n} не должен упоминать OpenRouter`);
  }
});

test("2: клиент Anthropic создаётся ровно в одном транспорте", () => {
  const withClient = libFiles.filter((f) => codeOf(f.src).includes("new Anthropic(")).map((f) => f.name);
  assert.deepEqual(withClient, ["mediaLlm.ts"], `обходные клиенты: ${withClient.join(", ")}`);

  // Brave вызывается только из поискового модуля
  // Brave вызывается только из поисковых модулей, и каждый такой вызов проходит политику
  // balances.ts делает один запрос ради заголовков с лимитами — это чтение остатка, не поиск
  const braveCallers = libFiles.filter((f) => codeOf(f.src).includes("api.search.brave.com") && f.name !== "balances.ts");
  for (const f of braveCallers) {
    assert.ok(/^broll(Web)?\.ts$|^braveSearch\.ts$/.test(f.name), `Brave вне поиска: ${f.name}`);
    assert.ok(codeOf(f.src).includes('assertProvider("Media Research", "brave")'), `${f.name}: вызов Brave без политики`);
    assert.ok(codeOf(f.src).includes("recordRequest("), `${f.name}: запрос Brave не попадает в учёт`);
  }

  // запасного платного поисковика быть не должно: это подмена провайдера
  for (const f of libFiles) {
    assert.ok(!/serper|google\.serper\.dev/i.test(codeOf(f.src)), `${f.name}: запасной платный поиск`);
  }
});

test("3: политика проверяется ДО сетевого запроса", () => {
  const check = (name: string, marker: string) => {
    const src = libFiles.find((f) => f.name === name)!.src;
    const guard = src.indexOf("assertProvider(");
    const request = src.indexOf(marker);
    assert.ok(guard >= 0, `${name}: проверка политики есть`);
    assert.ok(request >= 0, `${name}: сетевой вызов найден`);
    assert.ok(guard < request, `${name}: проверка стоит раньше запроса`);
  };
  check("mediaLlm.ts", "client.messages.create");
  check("braveSearch.ts", "await fetch(url");
  check("coverProvider.ts", "await fetch(\"https://openrouter.ai");

  // автоматических переходов между провайдерами и транспортами нет: транспорт — из настройки
  const llm = libFiles.find((f) => f.name === "mediaLlm.ts")!.src;
  assert.ok(!/fallback|иначе.*openrouter/i.test(codeOf(llm)), "нет логики перехода на другого провайдера");
  assert.ok(codeOf(llm).includes('process.env.MEDIA_LLM_TRANSPORT'), "транспорт выбирается настройкой");
  assert.ok(!/catch[\s\S]{0,200}openrouterChat/.test(codeOf(llm)), "OpenRouter не вызывается из обработчика ошибок Anthropic");
});
