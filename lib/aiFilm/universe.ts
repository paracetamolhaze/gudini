import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Universe Lock — постоянный мир всех AI-фильмов проекта. Профиль лежит в
 * `assets/ai-film/universes/<id>/universe.json` и автоматически попадает в сценариста
 * (с целевым ощущением мира), в планировщик shots и в каждый production-промпт Veo
 * (описательно, без названий франшиз). Хэш профиля входит в ключ плана: другой мир —
 * другой план и другие сцены.
 */

export const DEFAULT_UNIVERSE_ID = "gudini-shinobi-world";

export type UniverseProfile = {
  id: string;
  name: string;
  /** только для внутренних инструкций сценариста; в промпты Veo не идёт */
  targetFeel: string;
  visualLanguage: string;
  architecture: string;
  clothingRules: string;
  technologyRules: string;
  socialRules: string;
  powerSystem: string;
  recurringObjects: string;
  environmentRules: string;
  adaptationRules: string[];
  forbiddenDrift: string;
  hash: string;
  file: string;
};

export function universeId(): string {
  return (process.env.AI_FILM_UNIVERSE_ID || DEFAULT_UNIVERSE_ID).trim();
}

export function universesDir(): string {
  const v = process.env.AI_FILM_UNIVERSE_DIR;
  return v ? path.resolve(v) : path.join(process.cwd(), "assets", "ai-film", "universes");
}

const req = (v: unknown, field: string, file: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Профиль мира ${file}: нет поля «${field}»`);
  return v.trim();
};

export function loadUniverseProfile(id = universeId(), baseDir = universesDir()): UniverseProfile {
  const file = path.join(baseDir, id, "universe.json");
  if (!fs.existsSync(file)) throw new Error(`AI-фильм: нет профиля мира «${id}» (${file}). Universe Lock обязателен`);
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`Профиль мира ${file}: не JSON (${e?.message ?? e})`);
  }
  const rules = Array.isArray(raw.adaptationRules) ? raw.adaptationRules.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
  if (!rules.length) throw new Error(`Профиль мира ${file}: нет adaptationRules`);
  return {
    id: req(raw.id ?? id, "id", file),
    name: req(raw.name, "name", file),
    targetFeel: req(raw.targetFeel, "targetFeel", file),
    visualLanguage: req(raw.visualLanguage, "visualLanguage", file),
    architecture: req(raw.architecture, "architecture", file),
    clothingRules: req(raw.clothingRules, "clothingRules", file),
    technologyRules: req(raw.technologyRules, "technologyRules", file),
    socialRules: req(raw.socialRules, "socialRules", file),
    powerSystem: req(raw.powerSystem, "powerSystem", file),
    recurringObjects: req(raw.recurringObjects, "recurringObjects", file),
    environmentRules: req(raw.environmentRules, "environmentRules", file),
    adaptationRules: rules,
    forbiddenDrift: req(raw.forbiddenDrift, "forbiddenDrift", file),
    hash: crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12),
    file,
  };
}

/** Блок для production-промпта Veo: описательно, компактно, без названия франшизы. */
export function universePromptBlock(u: UniverseProfile): string {
  return (
    `Universe (the same in every shot): ${u.name}. ${u.visualLanguage}. ` +
    `Setting: ${u.architecture}. Clothing: ${u.clothingRules}. Technology: ${u.technologyRules}. ` +
    `Objects: ${u.recurringObjects}. Powers: ${u.powerSystem}. ${u.environmentRules}. ` +
    `Never drift into: ${u.forbiddenDrift}.`
  );
}

/** Блок для сценариста: целевое ощущение мира и правила перевода современных понятий. */
export function universePlannerBlock(u: UniverseProfile): string {
  return (
    `UNIVERSE LOCK. Все AI-сцены без исключений происходят в одном мире «${u.name}» (id ${u.id}). Целевое ощущение: ${u.targetFeel}.\n` +
    `Визуальный язык: ${u.visualLanguage}. Архитектура и места: ${u.architecture}. Одежда: ${u.clothingRules}. Технологии: ${u.technologyRules}. ` +
    `Общество: ${u.socialRules}. Силы и оружие: ${u.powerSystem}. Повторяющиеся предметы: ${u.recurringObjects}. Среда: ${u.environmentRules}.\n` +
    `Современные понятия НЕ вставляются как есть — они ПЕРЕВОДЯТСЯ в правила мира: ${u.adaptationRules.join("; ")}. ` +
    `Не делать современный город с человеком в жилете ниндзя, если ситуацию можно перевести в правила мира.\n` +
    `Запрещённый дрейф (anti-drift): ${u.forbiddenDrift}. Каждый shot должен явно принадлежать этому миру.\n` +
    `Для каждого AI-бита заполни universeAdaptation (английский, 1–2 предложения): как именно исходная мысль автора переведена в события этого мира ` +
    `(например «компания теряет клиентов» → «Gudini's merchant clan storefront in the village empties as customers move to a newly opened rival clan shop across the street»). ` +
    `В production-промптах названия франшиз, студий и чужих персонажей не пишутся — только описание мира выше.`
  );
}
