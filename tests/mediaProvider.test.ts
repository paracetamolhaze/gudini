import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

/**
 * Медиа-конвейер ходит только к своему провайдеру, а обязательные стадии
 * не превращаются молча в пустой результат.
 */

const beats = fs.readFileSync("lib/scriptBeats.ts", "utf8");
const pack = fs.readFileSync("lib/storyAssetPack.ts", "utf8");
const director = fs.readFileSync("lib/creativeDirector.ts", "utf8");
const llm = fs.readFileSync("lib/mediaLlm.ts", "utf8");

test("1: все три стадии ходят через общий транспорт, и он только Anthropic", () => {
  for (const [name, src] of [["scriptBeats", beats], ["storyAssetPack", pack], ["creativeDirector", director]] as const) {
    assert.ok(src.includes("mediaComplete("), `${name} использует общий транспорт`);
    assert.ok(!src.includes("new Anthropic("), `${name} не создаёт клиента Anthropic напрямую`);
  }
  assert.ok(llm.includes("MEDIA_LLM_MODEL"), "модель задаётся через env");
  // проверяем КОД, а не комментарии: в них правило объясняется словами
  const code = llm
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.ok(!/openrouter/i.test(code), "OpenRouter в медиа-конвейере отсутствует физически");
  assert.ok(!code.includes("openrouter.ai"), "к OpenRouter из медиа-конвейера не ходят");
  assert.ok(llm.includes("anthropicKeyOrFail"), "без ключа Anthropic стадия падает, а не идёт к другому провайдеру");
});

test("2: обязательная стадия падает, а не возвращает пустоту", () => {
  // разбор сценария
  assert.ok(beats.includes("throw new Error"), "buildScriptBeats бросает ошибку");
  // чтение сохранённого кэша может вернуть null — это не проглатывание стадии.
  // Проверяем именно сам разбор: после вызова модели тихого null быть не должно.
  const buildFn = beats.slice(beats.indexOf("export async function buildScriptBeats"));
  assert.ok(!/mediaComplete[\s\S]*?} catch {\s*return null;/.test(buildFn), "разбор не возвращает null после вызова модели");
  // сопоставление с блоками — именно здесь были потеряны готовые сегменты
  assert.ok(
    pack.includes("Сопоставление с блоками не выполнено"),
    "сбой сопоставления виден как ошибка",
  );
  assert.ok(
    pack.includes("но ни один не сопоставлен с блоками сценария"),
    "материал есть, а совместимых нет — это ошибка, а не пустой пакет",
  );
  // режиссёр
  assert.ok(!/} catch {\s*return null;\s*}/.test(director), "режиссёр не глотает ошибку разбора");
  assert.ok(director.includes("Режиссёр монтажа не запущен"), "режиссёр останавливает конвейер явно");
});

test("3: качаем не всё подряд, а лучших по метаданным", () => {
  assert.ok(pack.includes("export function scoreCandidate"), "есть оценка кандидата по метаданным");
  const fn = pack.slice(pack.indexOf("export function scoreCandidate"), pack.indexOf("/** Запрос под конкретный блок"));
  assert.ok(fn.includes("r.entities"), "учитываются участники");
  assert.ok(fn.includes("r.canonicalEvent"), "учитывается каноническое событие");
  assert.ok(fn.includes("r.eventYear"), "учитывается год события");
  assert.ok(fn.includes("c.publisher"), "учитывается канал/источник");
  // шорт-лист ограничен и настраивается профилем, а не зашит в цикл
  assert.ok(pack.includes("T0.core_download_shortlist"), "размер шорт-листа берётся из профиля");
  assert.ok(pack.includes(".sort((a, b) => b[1].score - a[1].score)"), "качаем в порядке убывания оценки");
});

test("4: YouTube считается отдельной строкой отчёта", () => {
  for (const k of ["ytUrlsDiscovered", "ytDownloadAttempted", "ytDownloadOk", "ytSourceVideosAccepted", "ytSegments"]) {
    assert.ok(pack.includes(k), `счётчик ${k} есть`);
  }
  assert.ok(pack.includes("export const isYoutube"), "площадка определяется по домену");
});
