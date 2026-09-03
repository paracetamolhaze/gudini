import crypto from "crypto";
import fs from "fs";
import path from "path";
import { mediaComplete, parseJson, mediaLlmAvailable } from "./mediaLlm";
import { StoryResearchPack } from "./storyResearch";
import { addCost } from "./pipelineCost";

/**
 * Разбор сценария на визуальные блоки.
 *
 * Медиатеку нельзя собрать окончательно до сценария: исследование знает историю,
 * но не знает, какие именно куски войдут в 60-секундный текст. Поэтому сценарий
 * режется на блоки по 2–6 секунд, и уже под них ищется материал — но запрос при
 * этом всегда знает и всю историю целиком (событие, дату, участников).
 */

export type VisualNeed = "EXACT_EVENT" | "ENTITY" | "CONTEXT" | "GENERAL" | "NONE";

export type ScriptBeat = {
  id: string;
  text: string;
  factIds: string[];
  visualNeed: VisualNeed;
  entities: string[];
};

/** Что искать под конкретный блок. Таймкодов здесь нет — это не монтажный план. */
export type MediaResearchNeed = {
  beatId: string;
  factIds: string[];
  entities: string[];
  intent: Exclude<VisualNeed, "NONE">;
  visualDescription: string;
  preferredMedia: "VIDEO" | "IMAGE";
  /** насколько глубоко искать: центральные моменты истории заслуживают большего бюджета */
  importance: "HIGH" | "MEDIUM" | "LOW";
};

const BEATS_SYSTEM = `Ты — режиссёр монтажа. Тебе дают историю (событие, дату, участников, факты)
и готовый текст озвучки. Раздели текст на ВИЗУАЛЬНЫЕ БЛОКИ по 2–6 секунд речи.

Предложение не обязано быть одним блоком: длинное предложение обычно содержит два-три блока
(«Англия побеждает» / «все бегут праздновать» / «он прыгает через щит» — это три блока).

Для каждого блока укажи:
- text: дословный фрагмент текста озвучки;
- factIds: какие факты истории он излагает (пусто, если это связка или призыв);
- entities: кто/что упоминается (имена из списка участников);
- visualNeed:
  EXACT_EVENT — нужен кадр именно этого события/действия,
  ENTITY — достаточно показать участника,
  CONTEXT — обстановка истории (стадион, команда, трибуны),
  GENERAL — общее понятие, годится обычный сток,
  NONE — визуал не нужен (хук, личная реакция, призыв);
- visualDescription: одно предложение на английском — что должно быть в кадре. Формулируй под
  тип истории и памятку visualGuide: для кино — «official still of Doctor Doom from the
  Avengers: Doomsday trailer», «Avengers: Endgame poster», а не описание съёмки события;
- preferredMedia: VIDEO для действий и движения, IMAGE для человека или статичного факта;
  для кино, объяснений и продуктов почти всегда IMAGE — готовых картинок много, видео дороже;
- importance: HIGH для центральных моментов истории, MEDIUM для поддерживающих, LOW для проходных.

Ответь СТРОГО валидным JSON:
{"beats":[{"text":"...","factIds":["f1"],"entities":["Jordan Henderson"],"visualNeed":"EXACT_EVENT",
"visualDescription":"...","preferredMedia":"VIDEO","importance":"HIGH"}]}`;

const bid = (s: string, i: number) => `b${i}_${crypto.createHash("sha1").update(s).digest("hex").slice(0, 4)}`;

/**
 * Версия разбора сценария на блоки. Меняется вместе с промптом или схемой
 * ответа: тогда сохранённые блоки действительно устарели.
 */
export const BEATS_VERSION = 1;

export type SavedBeats = {
  version: number;
  fingerprint: string;
  beats: ScriptBeat[];
  needs: MediaResearchNeed[];
  createdAt: string;
};

/** Отпечаток входных данных разбора: сценарий, история и версия самого разбора. */
export function beatsFingerprint(script: string, research: StoryResearchPack): string {
  const payload = JSON.stringify({
    script: script.trim(),
    story: research.storyId,
    // тип истории меняет формулировку потребностей: блоки, разобранные «как для новостей», пересобираются
    kind: research.kind ?? "NEWS_EVENT",
    event: research.canonicalEvent,
    facts: research.facts.map((f) => f.id).sort(),
    entities: research.entities.map((e) => e.name).sort(),
    beatsVersion: BEATS_VERSION,
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

const BEATS_FILE = "script-beats.json";

/**
 * Ранее разобранные блоки для тех же входных данных.
 * Разбор сценария — платный вызов, и повторять его при неизменных сценарии
 * и истории незачем: результат будет тот же.
 */
export function reusableBeats(dir: string, fingerprint: string): SavedBeats | null {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, BEATS_FILE), "utf8")) as SavedBeats;
    if (saved.version !== BEATS_VERSION || saved.fingerprint !== fingerprint) return null;
    if (!Array.isArray(saved.beats) || !saved.beats.length) return null;
    return saved;
  } catch {
    return null;
  }
}

export function saveBeats(dir: string, saved: SavedBeats): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BEATS_FILE), JSON.stringify(saved, null, 2), "utf8");
  } catch {}
}

/**
 * Режет сценарий на блоки и сразу формирует план медиа-исследования.
 * Один вызов модели: блоки и потребность в визуале определяются вместе.
 */
export async function buildScriptBeats(
  script: string,
  research: StoryResearchPack,
  dir?: string,
): Promise<{ beats: ScriptBeat[]; needs: MediaResearchNeed[]; reused?: boolean }> {
  const fingerprint = beatsFingerprint(script, research);
  if (dir) {
    const saved = reusableBeats(dir, fingerprint);
    if (saved) {
      console.log(`Блоки сценария уже разобраны (отпечаток ${fingerprint}): ${saved.beats.length}. Платный вызов не нужен.`);
      return { beats: saved.beats, needs: saved.needs, reused: true };
    }
  }
  if (!mediaLlmAvailable() || !script.trim()) {
    throw new Error("Разбор сценария на блоки невозможен: нет доступного LLM-провайдера");
  }

  const facts = research.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  const raw = await mediaComplete({
    system: BEATS_SYSTEM,
    maxTokens: 8000,
    stage: "Script Beats",
    user:
      `История: ${research.canonicalEvent}\n` +
      `Тип истории: ${research.kind ?? "NEWS_EVENT"}\n` +
      (research.visualGuide ? `Памятка по визуалу: ${research.visualGuide}\n` : "") +
      (research.eventDate ? `Дата: ${research.eventDate}\n` : "") +
      `Участники: ${research.entities.map((e) => e.name).join(", ")}\n\n` +
      `Факты:\n${facts}\n\nТекст озвучки:\n${script}`,
  });
  addCost({ researchLlmCalls: 1 });

  {
    const json = parseJson<any>(raw, "Разбор сценария на блоки");
    const known = new Set(research.facts.map((f) => f.id));
    const beats: ScriptBeat[] = [];
    const needs: MediaResearchNeed[] = [];

    (Array.isArray(json.beats) ? json.beats : []).forEach((b: any, i: number) => {
      const text = String(b.text ?? "").trim();
      if (text.length < 4) return;
      const need: VisualNeed = (["EXACT_EVENT", "ENTITY", "CONTEXT", "GENERAL", "NONE"] as VisualNeed[]).includes(
        b.visualNeed,
      )
        ? b.visualNeed
        : "CONTEXT";
      const id = bid(text, i);
      const factIds = (Array.isArray(b.factIds) ? b.factIds.map(String) : []).filter((f: string) => known.has(f));
      const entities = Array.isArray(b.entities) ? b.entities.map(String).filter(Boolean).slice(0, 4) : [];

      beats.push({ id, text, factIds, visualNeed: need, entities });
      if (need === "NONE") return;
      needs.push({
        beatId: id,
        factIds,
        entities,
        intent: need,
        visualDescription: String(b.visualDescription ?? text).slice(0, 160),
        preferredMedia: b.preferredMedia === "IMAGE" ? "IMAGE" : "VIDEO",
        importance: (["HIGH", "MEDIUM", "LOW"] as const).includes(b.importance) ? b.importance : "MEDIUM",
      });
    });

    if (!beats.length) throw new Error("Разбор сценария на блоки: модель не вернула ни одного блока");
    if (dir) saveBeats(dir, { version: BEATS_VERSION, fingerprint, beats, needs, createdAt: new Date().toISOString() });
    return { beats, needs, reused: false };
  }
}
