import type { CharacterProfile, PlanIssue, StoryBeat, StoryBible, StoryEvent } from "./types";

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

/** Что-то важное находится НАД человеком. */
const OBJECT_ABOVE = /\babove (?:him|his head|gudini)\b|\boverhead\b/i;

/** Глаголы действия — по их числу видно, что в сцену запихнули несколько событий сразу. */
const ACTION_VERB =
  /\b(?:tears?|rips?|opens?|pulls?|drops?|falls?|jumps?|steps?|lands?|throws?|breaks?|snaps?|deploys?|catches?|hits?|cuts?|lifts?|pushes?|closes?|clicks?|presses?|taps?|grabs?|releases?|climbs?|runs?|walks?|turns?|reaches?|stumbles?|kneels?|sits?|stands?)\b/gi;

export type { PlanIssue } from "./types";
/** прежнее имя типа */
export type PlanAudit = PlanIssue;

/**
 * Показано ли событие. Проверяется по предметам, а не по словам: сцена обязана объявить
 * тот же предмет и то же состояние после, которое обещает событие. Приземление не может
 * закрыть событие «отзыв», потому что предметы у них разные.
 */
export function eventCovered(event: StoryEvent, beats: StoryBeat[]): boolean {
  const claiming = beats.filter((b) => isAi(b) && (b.eventIds ?? []).includes(event.id));
  if (!claiming.length) return false;
  if (!event.objects.length) return claiming.some((b) => b.keyMoment.trim().length > 0);
  // хотя бы один предмет события меняется в сцене так, как обещано
  return claiming.some((b) =>
    event.objects.some((want) => {
      const got = (b.objects ?? []).find((o) => o.id === want.id);
      if (!got) return false;
      const after = got.after.trim().toLowerCase();
      return after.length > 0 && after !== got.before.trim().toLowerCase();
    }),
  );
}

export function auditPlan(
  beats: StoryBeat[],
  bible: StoryBible,
  character: Pick<CharacterProfile, "name" | "referenceFiles">,
): PlanIssue[] {
  const out: PlanIssue[] = [];
  const shown = beats.filter(isAi);
  const add = (code: string, ids: string[], message: string, severity: "block" | "warn" = "warn") => {
    if (ids.length) out.push({ code, severity, beatIds: ids, message });
  };

  // Обязательные события. Проверяется ПОСЛЕ нормализации, группировки и сокращения бюджета:
  // именно там события пропадали незаметно.
  const missing = (bible.events ?? []).filter((e) => e.required && !eventCovered(e, beats));
  if (missing.length) {
    out.push({
      code: "event-not-covered",
      severity: "block",
      beatIds: [],
      eventIds: missing.map((e) => e.id),
      message: `Обязательные события не показаны: ${missing.map((e) => `${e.id} (${e.observable})`).join("; ")}`,
    });
  }

  // Крупность против композиции: на крупном плане в кадр не влезет то, ради чего
  // оставляли место сверху или снизу.
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

  // Камера одновременно неподвижна и движется. Смотрим только клаузу про камеру:
  // после точки с запятой описывается движение ЧЕЛОВЕКА, и «his hands move toward
  // the camera» — это не движение камеры.
  add(
    "camera-static-and-moving",
    shown
      .filter((b) => {
        const c = b.camera.split(";")[0];
        return /\bstatic\b|\bfixed\b|\blocked[- ]off\b/i.test(c) && CAMERA_MOVES.test(c);
      })
      .map((b) => b.id),
    "Камера описана и как неподвижная, и как движущаяся",
    "block",
  );

  // Камера сверху и предмет НАД человеком: предмет окажется между ним и камерой и закроет
  // кадр. Ровно этот класс уже испортил одну оплаченную сцену, только выраженный иначе.
  add(
    "camera-above-object-above",
    shown
      .filter((b) => b.cameraAngle === "overhead" || b.cameraAngle === "high_angle")
      .filter((b) => OBJECT_ABOVE.test(`${b.visualAction} ${b.keyMoment}`))
      .map((b) => b.id),
    "Камера сверху, а важное находится НАД человеком — оно закроет собой кадр",
    "block",
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
    shown.filter((b) => b.visualAction.length > 0 && b.gudiniVisible !== b.visualAction.includes(character.name)).map((b) => b.id),
    `Флаг присутствия ${character.name} в кадре расходится с текстом действия`,
  );

  // Просьба показать читаемый текст.
  add(
    "readable-text",
    shown.filter((b) => READABLE.test(`${b.visualAction} ${b.keyMoment}`)).map((b) => b.id),
    "Сцена требует читаемый текст на экране или бумаге — Veo его не выводит",
    "block",
  );

  // Состояние отыгрывается назад — но у КОНКРЕТНОГО предмета. Сравнение по словам без
  // идентификатора ошибалось в обе стороны: переход от порванного основного купола к
  // упакованному запасному считался восстановлением, а настоящее восстановление основного
  // терялось, если рядом упоминался другой повреждённый предмет.
  const regress: string[] = [];
  const lastSeen = new Map<string, string>();
  for (const b of shown) {
    for (const o of b.objects ?? []) {
      const prev = lastSeen.get(o.id);
      if (prev && DAMAGED.test(prev) && INTACT.test(o.before) && !DAMAGED.test(o.before)) regress.push(`${b.id}/${o.id}`);
      if (o.after) lastSeen.set(o.id, o.after);
    }
  }
  add("state-regression", regress, "Повреждённый предмет снова целый в следующей сцене", "block");

  // Место действия возвращается через сцену — флешбэк, а в ролике он читается как ошибка.
  const flash: string[] = [];
  for (let i = 2; i < shown.length; i++) {
    const a = shown[i - 2].location.trim().toLowerCase();
    const b = shown[i - 1].location.trim().toLowerCase();
    const c = shown[i].location.trim().toLowerCase();
    if (a && b && c && a === c && a !== b) flash.push(shown[i].id);
  }
  add("location-jump-back", flash, "Действие возвращается в прежнее место через сцену — порядок событий выглядит сломанным", "block");

  // Сцена с героем без эталонов: лицо будет случайным.
  if (!character.referenceFiles.length) {
    add("no-references", shown.filter((b) => b.gudiniVisible).map((b) => b.id), "Сцены с героем без эталонных картинок — лицо не удержится");
  }

  return out;
}
