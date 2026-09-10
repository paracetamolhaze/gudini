import type { CharacterProfile, StoryBeat, StoryBible } from "./types";

/**
 * Разбор готового плана на противоречия — все известные классы разом, до генерации.
 *
 * Появился после того, как дефекты находились по одному, каждый после оплаченного ролика:
 * камера сверху и снизу в одном промпте, ракурс «из-за плеча» с камерой перед героем,
 * склейка внутри непрерывного кадра. Проверка бесплатна и не требует ни Claude, ни Veo,
 * поэтому запускается на каждом плане.
 *
 * Здесь только то, что видно из самого плана. Художественное качество и «интересно ли это
 * смотреть» отсюда не проверяются.
 */

const isAi = (b: StoryBeat) => b.displayMode !== "author";

/** Слова состояния, у которых есть направление: обратно они не отыгрываются. */
const DAMAGED = /\b(?:torn|shredded|ripped|broken|smashed|cracked|burnt|burned|spilled|empty|collapsed|deflated)\b/i;
const INTACT = /\b(?:intact|whole|unopened|sealed|new|full|folded|packed|closed)\b/i;

/** Просьбы к генератору показать читаемый текст — он их не выполняет. */
const READABLE = /\b(?:screen (?:showing|displaying)|reads? "|text (?:on|saying)|price tag|label saying|receipt|invoice|the words?|caption|subtitle)\b/i;

/** Движение камеры. Вместе со словом static — противоречие. */
const CAMERA_MOVES = /\b(?:pans?|tilts?|tracks?|dollies|dolly|pushes in|pulls back|moves? (?:with|toward|away)|follows?|orbits?|circles?|cranes?|zooms?)\b/i;

/** Глаголы действия — по их числу видно, что в сцену запихнули несколько событий сразу. */
const ACTION_VERB =
  /\b(?:tears?|rips?|opens?|pulls?|drops?|falls?|jumps?|steps?|lands?|throws?|breaks?|snaps?|deploys?|catches?|hits?|cuts?|lifts?|pushes?|closes?|clicks?|presses?|taps?|grabs?|releases?|climbs?|runs?|walks?|turns?|reaches?|stumbles?|kneels?|sits?|stands?)\b/gi;

export type PlanAudit = { code: string; beatIds: string[]; message: string };

export function auditPlan(beats: StoryBeat[], bible: StoryBible, character: Pick<CharacterProfile, "name" | "referenceFiles">): PlanAudit[] {
  const out: PlanAudit[] = [];
  const shown = beats.filter(isAi);
  const add = (code: string, ids: string[], message: string) => {
    if (ids.length) out.push({ code, beatIds: ids, message });
  };

  // Крупность против композиции: на крупном плане не бывает «человек мелко в общем плане»,
  // и в него не влезает то, ради чего оставляли место сверху или снизу.
  add(
    "shot-vs-composition",
    shown.filter((b) => b.composition && b.shotType === "close" && b.composition !== "center").map((b) => b.id),
    "Крупный план вместе с местом в кадре под предмет: на крупности close туда ничего не поместится",
  );
  add(
    "wide-vs-composition",
    shown.filter((b) => b.composition === "subject_small_in_wide" && (b.shotType === "close" || b.shotType === "medium")).map((b) => b.id),
    "«Человек мелко в общем плане» стоит вместе с близкой крупностью",
  );

  // Камера одновременно неподвижна и движется.
  add(
    "camera-static-and-moving",
    // Смотрим только клаузу про камеру: после точки с запятой планировщик описывает
    // движение ЧЕЛОВЕКА, и «his hands move toward the camera» — это не движение камеры.
    shown
      .filter((b) => {
        const c = b.camera.split(";")[0];
        return /\bstatic\b|\bfixed\b|\blocked[- ]off\b/i.test(c) && CAMERA_MOVES.test(c);
      })
      .map((b) => b.id),
    "Камера описана и как неподвижная, и как движущаяся",
  );

  // Слишком много действий в одной сцене: Veo выполняет первое и путает остальные.
  add(
    "too-many-actions",
    shown.filter((b) => (b.visualAction.match(ACTION_VERB) ?? []).length > 3).map((b) => b.id),
    "В одной сцене больше трёх действий подряд — генератор выполнит первое и смажет остальные",
  );

  // Герой в кадре, но действие про него молчит, или наоборот.
  add(
    "hero-flag-mismatch",
    shown
      .filter((b) => b.gudiniVisible !== b.visualAction.includes(character.name))
      .filter((b) => b.visualAction.length > 0)
      .map((b) => b.id),
    `Флаг присутствия ${character.name} в кадре расходится с текстом действия`,
  );

  // Просьба показать читаемый текст.
  add(
    "readable-text",
    shown.filter((b) => READABLE.test(`${b.visualAction} ${b.keyMoment}`)).map((b) => b.id),
    "Сцена требует читаемый текст на экране или бумаге — Veo его не выводит",
  );

  // Состояние предмета отыгрывается назад: было порвано, стало целым.
  const regress: string[] = [];
  for (let i = 1; i < shown.length; i++) {
    const before = `${shown[i - 1].stateAfter}`;
    const now = `${shown[i].stateBefore}`;
    if (DAMAGED.test(before) && INTACT.test(now) && !DAMAGED.test(now)) regress.push(shown[i].id);
  }
  add("state-regression", regress, "Повреждённый предмет снова целый в следующей сцене");

  // Место действия возвращается назад через сцену — это флешбэк, а в ролике он читается как ошибка.
  const flash: string[] = [];
  for (let i = 2; i < shown.length; i++) {
    const a = shown[i - 2].location.trim().toLowerCase();
    const b = shown[i - 1].location.trim().toLowerCase();
    const c = shown[i].location.trim().toLowerCase();
    if (a && b && c && a === c && a !== b) flash.push(shown[i].id);
  }
  add("location-jump-back", flash, "Действие возвращается в прежнее место через сцену — порядок событий выглядит сломанным");

  // Сцена с героем без эталонов: лицо будет случайным.
  if (!character.referenceFiles.length) {
    add("no-references", shown.filter((b) => b.gudiniVisible).map((b) => b.id), "Сцены с героем без эталонных картинок — лицо не удержится");
  }

  return out;
}

