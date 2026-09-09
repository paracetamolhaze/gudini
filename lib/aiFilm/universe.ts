import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Universe Lock — постоянный СТИЛЬ всех AI-фильмов проекта: рисовка и дизайн персонажей.
 * Мира как отдельной выдумки нет: места берутся из истории и рисуются в этом стиле. Содержание сцен при этом буквальное: зритель
 * видит то, о чём говорит автор (людей, события, предметы, места из речи), нарисованное
 * в этом стиле; метафоры «клан вместо компании» запрещены. Профиль лежит в
 * `assets/ai-film/universes/<id>/universe.json` и попадает в сценариста, в планировщик
 * shots и в каждый production-промпт Veo (описательно, без названий франшиз). Хэш профиля
 * входит в ключ плана.
 */

export const DEFAULT_UNIVERSE_ID = "gudini-anime-cel";

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
  /** правила буквального содержания: что показываем и как рисуем известных персонажей */
  contentRules: string[];
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
  const rules = Array.isArray(raw.contentRules) ? raw.contentRules.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
  if (!rules.length) throw new Error(`Профиль мира ${file}: нет contentRules`);
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
    contentRules: rules,
    forbiddenDrift: req(raw.forbiddenDrift, "forbiddenDrift", file),
    hash: crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12),
    file,
  };
}

/** Блок для production-промпта Veo: стиль и мир описательно, содержание буквальное, без названия франшизы. */
export function universePromptBlock(u: UniverseProfile): string {
  return (
    `Universe (the same in every shot): ${u.name}. ${u.visualLanguage}. ` +
    `Setting: ${u.architecture}. Clothing: ${u.clothingRules}. Technology: ${u.technologyRules}. ` +
    `Objects: ${u.recurringObjects}. Powers: ${u.powerSystem}. ${u.environmentRules}. ` +
    `Content is literal: show exactly the people, events and places of the story, drawn in this style. ` +
    `Never drift into: ${u.forbiddenDrift}.`
  );
}

/** Блок для сценариста: стиль зафиксирован, содержание буквально по речи. */
export function universePlannerBlock(u: UniverseProfile): string {
  return (
    `STYLE LOCK. Все AI-сцены без исключений нарисованы в одном стиле «${u.name}» (id ${u.id}). Целевое ощущение: ${u.targetFeel}.\n` +
    `Визуальный язык: ${u.visualLanguage}. Архитектура по умолчанию: ${u.architecture}. Одежда: ${u.clothingRules}. Технологии: ${u.technologyRules}. ` +
    `Общество: ${u.socialRules}. Силы и оружие: ${u.powerSystem}. Предметы: ${u.recurringObjects}. Среда: ${u.environmentRules}.\n` +
    `СОДЕРЖАНИЕ БУКВАЛЬНОЕ. Зритель должен ВИДЕТЬ то, о чём говорит автор: тех самых людей, события, предметы и места, нарисованные в этом стиле. ` +
    `Если автор говорит про гибель героя в броне, в кадре гибель героя в броне; про титана с перчаткой — титан с перчаткой; про новую команду — эта команда. ` +
    `Правила: ${u.contentRules.join("; ")}.\n` +
    `Запрещено: ${u.forbiddenDrift}.\n` +
    `Для каждого AI-бита заполни universeAdaptation (английский, 1–2 предложения): ЧТО ИМЕННО из сказанного показано в кадре ` +
    `(например «Tony Stark's sacrifice → Tony Stark in his red-and-gold armor on one knee, chest reactor flickering out, Gudini kneeling beside him»). ` +
    `В visualAction (он идёт в генератор видео) известных персонажей называй прямо по имени и добавляй короткий узнаваемый облик (armor colors, gauntlet, shield, metal arm, cape) — генератор знает, кто это.`
  );
}
