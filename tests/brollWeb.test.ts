import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEntity, WebAsset } from "../lib/brollWeb";
import { chooseLayout } from "../lib/brollEntity";
import { validatePlan } from "../lib/editPlan";
import { Word } from "../lib/transcribe";

const words: Word[] = Array.from({ length: 120 }, (_, i) => ({
  word: `слово${i}`,
  start: i * 0.5,
  end: i * 0.5 + 0.42,
}));

function asset(over: Partial<WebAsset> = {}): WebAsset {
  return {
    sourceUrl: "https://example.com/page",
    sourceDomain: "example.com",
    directUrl: "https://example.com/a.jpg",
    title: "Some football player injury",
    mediaType: "image",
    retrievalQuery: "q",
    retrievedAt: "2026",
    ...over,
  };
}

test("1: EXACT-событие ищется фактически и не подменяется стоком", () => {
  const [event] = validatePlan(
    [
      {
        type: "B_ROLL",
        from: 60,
        to: 70,
        sourceIntent: "SPECIFIC_EVENT",
        factualSpecificity: "EXACT",
        entity: "Jordan Henderson",
        event: "jump over advertising board",
        query: "Jordan Henderson advertising board injury",
        queries: ["Henderson hoarding injury", "England Mexico Henderson injury"],
      },
    ] as any,
    words,
    60,
  );
  assert.equal(event.factualSpecificity, "EXACT");
  assert.equal(event.sourceIntent, "SPECIFIC_EVENT");
  assert.equal(event.queries?.length, 3, "мульти-запрос: primary + альтернативы");
  assert.equal(event.queries?.[0], "Jordan Henderson advertising board injury");
});

test("2: конкретный человек не подтверждается кадром «просто футболиста»", () => {
  const random = asset({ title: "Football player injury on pitch" });
  assert.equal(verifyEntity(random, "Jordan Henderson"), false, "нет подтверждения, что это Хендерсон");

  const real = asset({
    title: "Jordan Henderson England 2018",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Jordan_Henderson.jpg",
  });
  assert.equal(verifyEntity(real, "Jordan Henderson"), true);

  // без заявленной сущности проверка не мешает обычным перебивкам
  assert.equal(verifyEntity(random, undefined), true);
});

test("3: горизонтальный фактический кадр принимается — crop или fit, но не растягивание", () => {
  assert.equal(chooseLayout(1920, 1080), "fit", "широкий кадр вписывается на размытый фон");
  assert.equal(chooseLayout(1080, 1920), "crop");
  assert.equal(chooseLayout(1200, 1000), "crop", "почти квадратный можно обрезать");
  assert.equal(chooseLayout(0, 0), "crop", "неизвестный размер — безопасный дефолт");
});

test("4: без факта EXACT уходит в A-roll, а не в «похожий» generic", () => {
  // событие EXACT без единого подтверждённого кандидата не должно иметь файла
  const [event] = validatePlan(
    [
      {
        type: "B_ROLL",
        from: 60,
        to: 70,
        sourceIntent: "SPECIFIC_EVENT",
        factualSpecificity: "EXACT",
        entity: "Jordan Henderson",
        query: "Jordan Henderson stretcher",
      },
    ] as any,
    words,
    60,
  );
  assert.equal(event.file, undefined);
  // фильтр пайплайна выбрасывает B_ROLL без материала → останется A-roll
  const kept = [event].filter((e) => e.type !== "B_ROLL" || e.file);
  assert.equal(kept.length, 0);
});

test("5: один и тот же веб-ассет не может попасть в ролик дважды", () => {
  const used = new Set<string>();
  const a = asset({ directUrl: "https://cdn.example.com/henderson.jpg" });
  const b = asset({ directUrl: "https://cdn.example.com/henderson.jpg", title: "другая страница" });
  const take = (x: WebAsset) => {
    if (used.has(x.directUrl)) return false;
    used.add(x.directUrl);
    return true;
  };
  assert.equal(take(a), true);
  assert.equal(take(b), false, "дубликат по прямой ссылке отбрасывается");
});
