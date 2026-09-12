import { test } from "node:test";
import assert from "node:assert/strict";
import { editProblems, extractJson, fitSlideCount, generationUser, normalizeDraft, normalizeRegenerated, repairUser } from "../lib/carousel/prompt";
import { buildSlideHtml, slideHash } from "../lib/carousel/templates";
import { CAROUSEL_STYLES } from "../lib/carousel/styles";
import type { Slide } from "../lib/carousel/types";

const CONTENT = [
  { kind: "content", kicker: "Шаг 1", title: "Ложитесь в одно время", body: "Стабильный режим важнее длины сна: организм привыкает засыпать быстрее.", bullets: [] },
  { kind: "content", kicker: "Шаг 2", title: "Утром выходите на свет", body: "Дневной свет в первые часы помогает вечером почувствовать сонливость.", bullets: [] },
  { kind: "content", kicker: "Шаг 3", title: "Кофе — только до обеда", body: "", bullets: ["Последняя чашка до 14:00", "Крепкий чай тоже бодрит"] },
  { kind: "content", kicker: "Шаг 4", title: "Прохладная тёмная спальня", body: "Проветрите комнату и уберите яркие источники света перед сном.", bullets: [] },
  { kind: "content", kicker: "Шаг 5", title: "Телефон за час до сна", body: "Ленты и сообщения держат мозг в напряжении — отложите экран заранее.", bullets: [] },
];

function plan() {
  const slides = [
    { kind: "cover", kicker: "Сон", title: "Как **высыпаться** за семь часов", body: "Простые привычки без таблеток", cta: "лишнее" },
    ...CONTENT.map((s) => ({ ...s, cta: "тоже лишнее" })),
    { kind: "final", kicker: "Итог", title: "Начните с одной привычки", body: "Выберите пункт и держите его неделю.", bullets: ["лишний список"], cta: "Сохрани, чтобы не потерять" },
  ];
  return {
    title: "Как высыпаться",
    story: slides.map((_, i) => `роль ${i + 1}`),
    slides,
    caption: "Первая строка-крючок.\n\nТекст подписи. Какая привычка вам ближе?\n\n#сон #здоровье",
    hashtags: ["#привычки"],
    claimsToCheck: [],
  };
}

test("хороший ответ разбирается без замечаний; поля не своего типа отбрасываются", () => {
  const r = normalizeDraft(plan(), { expectedCount: 7 });
  assert.deepEqual(r.fatal, []);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(
    r.draft.slides.map((s) => s.kind),
    ["cover", "content", "content", "content", "content", "content", "final"],
  );
  assert.equal(r.draft.slides[0].cta, "");
  assert.equal(r.draft.slides[1].cta, "");
  assert.deepEqual(r.draft.slides[6].bullets, []);
  assert.equal(r.draft.slides[6].cta, "Сохрани, чтобы не потерять");
  assert.deepEqual(r.draft.hashtags, ["#привычки", "#сон", "#здоровье"]);
  assert.ok(!r.draft.caption.includes("#"));
});

test("число карточек: не то — замечание, меньше трёх — непоправимо", () => {
  const p = plan();
  p.slides = [p.slides[0], p.slides[1], p.slides[2], p.slides[3], p.slides[6]];
  assert.match(normalizeDraft(p, { expectedCount: 7 }).problems.join(), /ровно 7/);
  const tiny = plan();
  tiny.slides = [tiny.slides[0], tiny.slides[6]];
  assert.match(normalizeDraft(tiny, { expectedCount: 7 }).fatal.join(), /минимум 3/);
});

test("длина, повторы и хэштеги на карточке — замечания для исправления", () => {
  const p = plan();
  p.slides[2] = { ...p.slides[2], body: "Очень длинный текст ".repeat(25) };
  p.slides[5] = { ...p.slides[5], title: p.slides[1].title };
  p.slides[3] = { ...p.slides[3], body: "Пейте воду #здоровье" };
  const problems = normalizeDraft(p, { expectedCount: 7 }).problems.join("\n");
  assert.match(problems, /карточка 3: body \d+ символов при пределе 200/);
  assert.match(problems, /карточки 2 и 6: заголовки повторяют друг друга/);
  assert.match(problems, /карточка 4: хэштеги на карточке/);
});

test("пустой заголовок — непоправимо", () => {
  const p = plan();
  p.slides[4] = { ...p.slides[4], title: "  " };
  assert.match(normalizeDraft(p, { expectedCount: 7 }).fatal.join(), /карточка 5: пустой заголовок/);
});

test("JSON извлекается из ограждения и из текста с преамбулой", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Вот ответ:\n```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.throws(() => extractJson("нет json"), /не разобрался/);
});

test("лишние карточки после исправления убираются, заключительная остаётся последней", () => {
  const p = plan();
  p.slides.splice(6, 0, { ...CONTENT[0], title: "Шестая мысль про сон", cta: "" }, { ...CONTENT[1], title: "Седьмая мысль про отдых", cta: "" });
  const draft = fitSlideCount(normalizeDraft(p).draft, 7);
  assert.equal(draft.slides.length, 7);
  assert.equal(draft.slides[6].kind, "final");
  assert.equal(draft.slides[6].title, "Начните с одной привычки");
  assert.equal(draft.slides[0].kind, "cover");
});

test("правка: id существующих слайдов сохраняются, чужие и повторные — сбрасываются", () => {
  const existing = [{ id: "sexisting000001" }, { id: "sexisting000002" }] as Slide[];
  const p = plan();
  (p.slides[0] as any).id = "sexisting000001";
  (p.slides[1] as any).id = "sunknown0000000";
  (p.slides[2] as any).id = "sexisting000001";
  const r = normalizeDraft(p, { existing });
  assert.equal(r.draft.slides[0].id, "sexisting000001");
  assert.equal(r.draft.slides[1].id, undefined);
  assert.equal(r.draft.slides[2].id, undefined);
});

test("правка по поручению: замечания только к изменённым карточкам и подписи", () => {
  const base = normalizeDraft(plan()).draft;
  const current = {
    slides: base.slides.map((s, i) => ({ ...s, id: `sid00000000000${i}` })) as Slide[],
    caption: base.caption,
    hashtags: base.hashtags,
  };
  // в нетронутой карточке 2 давно длинный текст — поручение касалось только карточки 4
  current.slides[1] = { ...current.slides[1], body: "Старый длинный текст ".repeat(15).trim() };
  const answer = {
    slides: current.slides.map((s, i) => (i === 3 ? { ...s, body: "Новый текст ".repeat(30).trim() } : s)),
    caption: current.caption,
    hashtags: current.hashtags,
  };
  const parsed = normalizeDraft(answer, { existing: current.slides });
  assert.ok(parsed.problems.some((p) => p.startsWith("карточка 2:")), "проверка видит старое превышение");
  const relevant = editProblems(parsed, current);
  assert.ok(relevant.some((p) => p.startsWith("карточка 4:")));
  assert.ok(!relevant.some((p) => p.startsWith("карточка 2:")), "нетронутая карточка не отправляется на исправление");

  const captionEdit = normalizeDraft({ ...answer, slides: current.slides, caption: "x".repeat(2300) }, { existing: current.slides });
  assert.ok(editProblems(captionEdit, current).some((p) => p.startsWith("caption:")));
});

test("перегенерация слайда сохраняет его тип", () => {
  const slides = normalizeDraft(plan()).draft.slides.map((s, i) => ({ ...s, id: `sid00000000000${i}` })) as Slide[];
  const r = normalizeRegenerated({ slide: { kind: "cover", title: "Свет по утрам", body: "Выходите на улицу в первый час после подъёма.", cta: "лишний" } }, { slides }, 2);
  assert.equal(r.slide.kind, "content");
  assert.equal(r.slide.cta, "");
  assert.deepEqual(r.fatal, []);
});

test("запрос к Claude: число карточек, язык, идея; исправление перечисляет замечания", () => {
  const user = generationUser({ idea: "Как высыпаться", wishes: "", slideCount: 7, language: "ru", style: "graphite", format: "square" }, new Date("2026-09-13T00:00:00Z"));
  assert.match(user, /Сегодня 2026-09-13/);
  assert.match(user, /ровно 7/);
  assert.match(user, /на русском языке/);
  assert.match(user, /«Как высыпаться»/);
  assert.match(user, /Квадратная карточка/);
  assert.match(repairUser({ a: 1 }, ["карточка 2: пустой заголовок"]), /- карточка 2: пустой заголовок/);
});

const base = { style: "graphite" as const, format: "portrait" as const, language: "ru" as const, footer: "@gudini" };
const slide = (over: Partial<Slide> = {}): Slide => ({ id: "sabcdefabcdef1", kind: "content", kicker: "Шаг 1", title: "Заголовок", body: "Текст", bullets: [], cta: "", ...over });

test("шаблон: текст модели экранируется, скриптов и внешних адресов нет", () => {
  const html = buildSlideHtml({
    carousel: base,
    slide: slide({ title: '<img src=x onerror="alert(1)">', body: "</style><script>alert(1)</script>", kicker: "https://evil.example" }),
    index: 1,
    total: 5,
    scale: 1,
    fontCss: "",
  });
  assert.ok(!/<img|<script/i.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  const tags = html.match(/<[^>]+>/g) ?? [];
  assert.ok(
    tags.every((t) => !/\s(src|href|on\w+)=/i.test(t)),
    "в разметке нет атрибутов загрузки и обработчиков",
  );
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), "стили не ссылаются на внешние адреса");
});

test("шаблон: акцент, номер, все стили и типы карточек собираются", () => {
  assert.match(buildSlideHtml({ carousel: base, slide: slide({ title: "Как **выспаться**" }), index: 1, total: 5, scale: 1, fontCss: "" }), /<span class="hl">выспаться<\/span>/);
  for (const st of CAROUSEL_STYLES) {
    for (const kind of ["cover", "content", "final"] as const) {
      const html = buildSlideHtml({ carousel: { ...base, style: st.id, format: "square" }, slide: slide({ kind }), index: 0, total: 3, scale: 0.86, fontCss: "" });
      assert.match(html, new RegExp(`kind-${kind}`));
    }
  }
});

test("отпечаток слайда меняется от текста, позиции, числа слайдов и стиля", () => {
  const h = slideHash(base, slide(), 1, 5);
  assert.equal(slideHash(base, slide(), 1, 5), h);
  assert.notEqual(slideHash(base, slide({ title: "Другой" }), 1, 5), h);
  assert.notEqual(slideHash(base, slide(), 2, 5), h);
  assert.notEqual(slideHash(base, slide(), 1, 6), h);
  assert.notEqual(slideHash({ ...base, style: "paper" }, slide(), 1, 5), h);
  assert.notEqual(slideHash({ ...base, footer: "" }, slide(), 1, 5), h);
});
