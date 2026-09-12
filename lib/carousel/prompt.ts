import type { Carousel, CarouselRequest, Slide, SlideKind } from "./types";
import { CAROUSEL_LIMITS, FORMATS, LANGUAGES, TEXT_LIMITS } from "./limits";
import { getStyle } from "./styles";
import { captionProblems, cleanCaption, cleanText, normalizeHashtags, splitTrailingHashtags, stripEmphasis, tooSimilar, visibleLength } from "./text";

/**
 * Промпты и разбор ответов Claude для каруселей. Модель возвращает только данные — JSON
 * с текстами полей; разметку, оформление и проверки задаёт код. Здесь чистые функции:
 * они проверяются тестами без сети и без денег.
 */

export type DraftSlide = { id?: string; kind: SlideKind; kicker: string; title: string; body: string; bullets: string[]; cta: string };

export type Draft = {
  title: string;
  story: string[];
  slides: DraftSlide[];
  caption: string;
  hashtags: string[];
  claimsToCheck: string[];
  summary: string;
};

/** problems — можно исправить повторным запросом; fatal — ответ негоден без исправления. */
export type Parsed = { draft: Draft; problems: string[]; fatal: string[] };

export const KIND_LABEL: Record<SlideKind, string> = { cover: "обложка", content: "содержательная", final: "заключительная" };

export function todayLine(now = new Date()): string {
  return `Сегодня ${now.toISOString().slice(0, 10)}.`;
}

export const WRITER_RULES = `Ты — редактор экспертных каруселей для Instagram. Пишешь тексты карточек, которые затем программно вёрстаются крупным шрифтом, и подпись к посту.

Как писать:
- Одна карточка — одна мысль. Карточки не повторяют друг друга ни словами, ни смыслом; каждая добавляет новое.
- Обложка цепляет: конкретная польза, интрига или сильное утверждение по теме. Без обмана и пустого кликбейта.
- Содержательные карточки выстроены как история: от проблемы или вопроса через разбор к решениям и выводу.
- Заключительная карточка подводит итог и даёт простой призыв без давления: сохранить, написать в комментариях, поделиться.
- Факты не выдумываются. Никаких придуманных исследований, статистики, процентов, цитат, имён, дат, цен и ссылок на источники. Если без точной цифры не обойтись, а уверенности нет — формулируй без цифры. Всё, что автору стоит проверить перед публикацией, перечисли в claimsToCheck (пустой массив, если проверять нечего).
- Не обещай медицинских, финансовых и юридических результатов.
- Коротко: карточку читают за 3–5 секунд. Текст карточки — 1–3 коротких предложения или короткий список. Простые слова, активный залог, без канцелярита и воды.
- На карточках нет эмодзи, хэштегов, ссылок и нумерации вида «1/7» — номер ставит вёрстка.
- В заголовке можно выделить 1–3 ключевых слова двойными звёздочками: **так**. Не больше одного выделения на заголовок; в других полях звёздочки не используются.

Пределы длины в символах с пробелами — не превышай:
- cover: kicker ≤ ${TEXT_LIMITS.cover.kicker} (метка над заголовком, можно пусто), title ≤ ${TEXT_LIMITS.cover.title}, body ≤ ${TEXT_LIMITS.cover.body} (подзаголовок, можно пусто).
- content: kicker ≤ ${TEXT_LIMITS.content.kicker} (например «Ошибка 2» или «Шаг 3», можно пусто), title ≤ ${TEXT_LIMITS.content.title}, и одно из двух: body ≤ ${TEXT_LIMITS.content.body} без списка, либо bullets из 2–${TEXT_LIMITS.content.bullets} пунктов ≤ ${TEXT_LIMITS.content.bullet} каждый и body ≤ ${TEXT_LIMITS.content.bodyWithBullets} или пусто.
- final: kicker ≤ ${TEXT_LIMITS.final.kicker}, title ≤ ${TEXT_LIMITS.final.title}, body ≤ ${TEXT_LIMITS.final.body}, cta ≤ ${TEXT_LIMITS.final.cta}.

Подпись caption: 400–1500 символов, живой текст, раскрывает тему глубже карточек и не повторяет их дословно; первая строка — крючок; в конце вопрос к читателю. Эмодзи в подписи умеренно или без них. Хэштегов в подписи нет: 5–12 штук отдельно в hashtags, по теме.`;

const GENERATION_FORMAT = `Ответ — строго один JSON-объект без markdown и пояснений:
{"title":"рабочее название до 90 символов","story":["роль карточки 1","..."],"slides":[{"kind":"cover","kicker":"","title":"","body":""},{"kind":"content","kicker":"","title":"","body":"","bullets":[]},{"kind":"final","kicker":"","title":"","body":"","cta":""}],"caption":"","hashtags":["#пример"],"claimsToCheck":[]}
story — план истории: по одной короткой строке на каждую карточку в том же порядке.`;

export function generationSystem(): string {
  return `${WRITER_RULES}\n\n${GENERATION_FORMAT}`;
}

export function generationUser(req: CarouselRequest, now = new Date()): string {
  const style = getStyle(req.style);
  const lines = [
    todayLine(now),
    `Идея: «${req.idea}»`,
    `Пожелания автора: ${req.wishes ? `«${req.wishes}»` : "нет"}`,
    `Карточек: ровно ${req.slideCount} — обложка, ${req.slideCount - 2} содержательных, заключительная.`,
    `Язык всех текстов: ${LANGUAGES[req.language].prompt}.`,
    `Оформление: стиль «${style.label}» (${style.description}), формат ${FORMATS[req.format].label}.`,
  ];
  if (req.format === "square") lines.push("Квадратная карточка ниже вертикальной — пиши ещё короче.");
  return lines.join("\n");
}

export function repairUser(previous: unknown, problems: string[]): string {
  return [
    "Проверка нашла замечания к твоему ответу. Исправь только то, что нарушено: сократи, убери повторы, добавь недостающее. Остальное оставь без изменений. Ответ — тот же JSON-формат целиком.",
    "",
    "Замечания:",
    ...problems.map((p) => `- ${p}`),
    "",
    "Твой ответ:",
    JSON.stringify(previous),
  ].join("\n");
}

export const EDIT_FORMAT = `Тебе дают готовую карусель в JSON (поле n — номер карточки, как её видит автор) и поручение автора. Выполни поручение точно и не меняй того, о чём не просили.
- Сохраняй id существующих карточек. У новой карточки id — пустая строка.
- Первая карточка — cover, последняя — final. Содержательные карточки можно переставлять, добавлять и удалять, только если поручение этого требует; всего от ${CAROUSEL_LIMITS.minSlides} до ${CAROUSEL_LIMITS.maxSlides} карточек.
- Подпись и хэштеги меняй, только если поручение их касается; иначе верни как были.
- Если поручение невыполнимо без выдумывания фактов, не выдумывай: сделай ближайшее честное изменение и скажи об этом в summary.
Ответ — строго один JSON-объект без markdown:
{"slides":[{"id":"","kind":"cover","kicker":"","title":"","body":"","bullets":[],"cta":""}],"caption":"","hashtags":[],"claimsToCheck":[],"summary":"что изменено — одна фраза для автора"}
summary пиши простыми словами для автора: «сократил текст второго слайда», а не названиями полей JSON (body, cta, kicker).`;

export function editSystem(): string {
  return `${WRITER_RULES}\n\n${EDIT_FORMAT}`;
}

export function carouselForPrompt(c: Pick<Carousel, "title" | "slides" | "caption" | "hashtags" | "claimsToCheck">): string {
  return JSON.stringify(
    {
      title: c.title,
      slides: c.slides.map((s, i) => ({ n: i + 1, id: s.id, kind: s.kind, kicker: s.kicker, title: s.title, body: s.body, bullets: s.bullets, cta: s.cta })),
      caption: c.caption,
      hashtags: c.hashtags,
      claimsToCheck: c.claimsToCheck,
    },
    null,
    1,
  );
}

export function instructUser(c: Carousel, instruction: string, now = new Date()): string {
  return [todayLine(now), `Язык карусели: ${LANGUAGES[c.language].prompt}.`, `Поручение автора: «${instruction}»`, "", "Карусель:", carouselForPrompt(c)].join("\n");
}

export const REGENERATE_FORMAT = `Тебе дают карусель и номер карточки, которую нужно написать заново: та же роль в истории, новая формулировка, без повторов с остальными карточками.
Ответ — строго один JSON-объект без markdown:
{"slide":{"kind":"content","kicker":"","title":"","body":"","bullets":[],"cta":""},"claimsToCheck":[]}`;

export function regenerateSystem(): string {
  return `${WRITER_RULES}\n\n${REGENERATE_FORMAT}`;
}

export function regenerateUser(c: Carousel, index: number, hint: string, now = new Date()): string {
  const s = c.slides[index];
  return [
    todayLine(now),
    `Язык карусели: ${LANGUAGES[c.language].prompt}.`,
    `Напиши заново карточку №${index + 1} (${KIND_LABEL[s.kind]}, kind="${s.kind}").`,
    `Пожелание автора: ${hint ? `«${hint}»` : "нет"}`,
    "",
    "Карусель:",
    carouselForPrompt(c),
  ].join("\n");
}

export function extractJson(raw: string): any {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }
  throw new Error("ответ Claude не разобрался как JSON");
}

export function kindAt(index: number, total: number): SlideKind {
  return index === 0 ? "cover" : index === total - 1 ? "final" : "content";
}

export function normalizeSlide(input: any, kind: SlideKind): DraftSlide {
  const bullets = kind === "content" && Array.isArray(input?.bullets) ? input.bullets.map((b: unknown) => cleanText(b)).filter(Boolean).slice(0, 6) : [];
  return {
    id: typeof input?.id === "string" && input.id ? input.id : undefined,
    kind,
    kicker: cleanText(input?.kicker),
    title: cleanText(input?.title),
    body: cleanText(input?.body),
    bullets,
    cta: kind === "final" ? cleanText(input?.cta) : "",
  };
}

export function slideProblems(s: DraftSlide, n: number): string[] {
  const k = TEXT_LIMITS[s.kind];
  const p: string[] = [];
  const over = (field: string, value: string, limit: number) => {
    const len = visibleLength(value);
    if (len > limit) p.push(`карточка ${n}: ${field} ${len} символов при пределе ${limit}`);
  };
  if (!s.title) p.push(`карточка ${n}: пустой заголовок`);
  over("kicker", s.kicker, k.kicker);
  over("title", s.title, k.title);
  over("body", s.body, s.bullets.length ? k.bodyWithBullets : k.body);
  if (s.kind === "content") {
    if (s.bullets.length > k.bullets) p.push(`карточка ${n}: пунктов списка ${s.bullets.length}, максимум ${k.bullets}`);
    if (s.bullets.length === 1) p.push(`карточка ${n}: список из одного пункта — перенесите его в body`);
    s.bullets.forEach((b, i) => over(`пункт ${i + 1}`, b, k.bullet));
    if (!s.body && !s.bullets.length) p.push(`карточка ${n}: нет содержания — нужен body или bullets`);
  }
  if (s.kind === "final") over("cta", s.cta, k.cta);
  if (/(^|\s)#[\p{L}\p{N}_]/u.test(`${s.kicker} ${s.title} ${s.body} ${s.bullets.join(" ")}`)) p.push(`карточка ${n}: хэштеги на карточке — перенесите в hashtags`);
  const extraStars = [s.kicker, s.body, ...s.bullets, s.cta].some((x) => x.includes("**"));
  if (extraStars) p.push(`карточка ${n}: звёздочки выделения допустимы только в заголовке`);
  return p;
}

export function repetitionProblems(slides: DraftSlide[]): string[] {
  const p: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    for (let j = i + 1; j < slides.length; j++) {
      const a = slides[i];
      const b = slides[j];
      if (tooSimilar(a.title, b.title)) p.push(`карточки ${i + 1} и ${j + 1}: заголовки повторяют друг друга`);
      else if (a.body.length > 40 && b.body.length > 40 && tooSimilar(a.body, b.body)) p.push(`карточки ${i + 1} и ${j + 1}: текст повторяется`);
    }
  }
  return p;
}

const uniq = (list: string[]) => [...new Set(list)];

function stringList(value: unknown, max: number, itemMax: number): string[] {
  return Array.isArray(value) ? value.map((x) => cleanText(x, { max: itemMax })).filter(Boolean).slice(0, max) : [];
}

/** Разбор ответа с каруселью целиком: генерация и правка по поручению. */
export function normalizeDraft(json: any, opts: { expectedCount?: number; existing?: Slide[] } = {}): Parsed {
  const fatal: string[] = [];
  const problems: string[] = [];
  const rawSlides: any[] = Array.isArray(json?.slides) ? json.slides : [];
  if (rawSlides.length > CAROUSEL_LIMITS.maxSlides) problems.push(`карточек ${rawSlides.length}, максимум ${CAROUSEL_LIMITS.maxSlides}`);
  const list = rawSlides.slice(0, CAROUSEL_LIMITS.maxSlides);
  if (opts.expectedCount && list.length !== opts.expectedCount) problems.push(`нужно ровно ${opts.expectedCount} карточек, получено ${list.length}`);
  if (list.length < CAROUSEL_LIMITS.minSlides) fatal.push(`карточек ${list.length}, минимум ${CAROUSEL_LIMITS.minSlides}`);

  const known = new Set((opts.existing ?? []).map((s) => s.id));
  const used = new Set<string>();
  const slides = list.map((raw, i) => {
    const s = normalizeSlide(raw, kindAt(i, list.length));
    if (s.id && (!known.has(s.id) || used.has(s.id))) s.id = undefined;
    if (s.id) used.add(s.id);
    return s;
  });
  slides.forEach((s, i) => {
    if (!s.title) fatal.push(`карточка ${i + 1}: пустой заголовок`);
    problems.push(...slideProblems(s, i + 1));
  });
  problems.push(...repetitionProblems(slides));

  const split = splitTrailingHashtags(cleanCaption(json?.caption));
  const rawTags = Array.isArray(json?.hashtags) ? json.hashtags : typeof json?.hashtags === "string" ? [json.hashtags] : [];
  const hashtags = normalizeHashtags([...rawTags, ...split.tags]);
  const caption = split.caption;
  if (!caption) problems.push("пустая подпись caption");
  problems.push(...captionProblems(caption, hashtags).map((x) => `caption: ${x}`));

  const title =
    cleanText(stripEmphasis(String(json?.title ?? "")), { max: CAROUSEL_LIMITS.titleMax }) ||
    cleanText(stripEmphasis(slides[0]?.title ?? ""), { max: CAROUSEL_LIMITS.titleMax });

  return {
    draft: {
      title,
      story: stringList(json?.story, CAROUSEL_LIMITS.maxSlides, 200),
      slides,
      caption,
      hashtags,
      claimsToCheck: stringList(json?.claimsToCheck, CAROUSEL_LIMITS.claimsMax, 240),
      summary: cleanText(json?.summary, { max: 300 }),
    },
    problems: uniq(problems.filter((x) => !fatal.includes(x))),
    fatal: uniq(fatal),
  };
}

/**
 * Замечания к правке по поручению — только о том, что правка затронула. Старые превышения
 * длины в нетронутых карточках повторным запросом не «исправляются»: иначе Claude
 * переписывает то, о чём автор не просил.
 */
export function editProblems(parsed: Parsed, current: Pick<Carousel, "slides" | "caption" | "hashtags">): string[] {
  const same = (d: DraftSlide) => {
    const old = d.id ? current.slides.find((s) => s.id === d.id) : undefined;
    return Boolean(old && old.kind === d.kind && old.kicker === d.kicker && old.title === d.title && old.body === d.body && old.cta === d.cta && JSON.stringify(old.bullets) === JSON.stringify(d.bullets));
  };
  const changed = new Set(parsed.draft.slides.map((d, i) => (same(d) ? -1 : i + 1)).filter((n) => n > 0));
  const captionChanged = parsed.draft.caption !== current.caption || parsed.draft.hashtags.join(" ") !== current.hashtags.join(" ");
  return parsed.problems.filter((p) => {
    const one = p.match(/^карточка (\d+):/);
    if (one) return changed.has(Number(one[1]));
    const pair = p.match(/^карточки (\d+) и (\d+):/);
    if (pair) return changed.has(Number(pair[1])) || changed.has(Number(pair[2]));
    if (/^caption|^пустая подпись/.test(p)) return captionChanged;
    return true;
  });
}

/** Лишние содержательные карточки после исправления убираются, чтобы число совпало с заказанным. */
export function fitSlideCount(draft: Draft, expected: number): Draft {
  if (draft.slides.length <= expected) return draft;
  const kept = [...draft.slides.slice(0, expected - 1), draft.slides[draft.slides.length - 1]];
  return {
    ...draft,
    slides: kept.map((s, i) => normalizeSlide(s, kindAt(i, kept.length))),
    story: draft.story.slice(0, expected),
  };
}

/** Разбор ответа с одной переписанной карточкой. */
export function normalizeRegenerated(json: any, c: Pick<Carousel, "slides">, index: number): { slide: DraftSlide; claims: string[]; problems: string[]; fatal: string[] } {
  const target = c.slides[index];
  const slide = normalizeSlide(json?.slide ?? json, target.kind);
  const fatal = slide.title ? [] : ["пустой заголовок"];
  const problems = slideProblems(slide, index + 1).filter((x) => !x.endsWith("пустой заголовок"));
  const others = c.slides.map((s, i) => (i === index ? slide : s));
  problems.push(...repetitionProblems(others).filter((x) => new RegExp(`\\b${index + 1}\\b`).test(x)));
  return { slide, claims: stringList(json?.claimsToCheck, CAROUSEL_LIMITS.claimsMax, 240), problems: uniq(problems), fatal };
}
