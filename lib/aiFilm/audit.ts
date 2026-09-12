import type { CharacterProfile, FilmShot, ObjectState, PlanIssue, StoryBeat, StoryBible, StoryEvent } from "./types";

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
/**
 * Прямая просьба показать РАЗБОРЧИВЫЙ текст: это Veo не выполняет, и кадр выходит с кашей
 * вместо букв. Запрет.
 */
const READABLE_HARD = /\b(?:reads? "|legible|readable|the words?|caption|subtitle|text (?:on|saying)|label saying|clearly shows the (?:price|number|name))\b/i;
/**
 * Экран или бумага в кадре с содержимым. Снять это можно — подпись выйдет нечитаемой, и
 * обычно это не мешает. Прежде сюда попадало и «screen showing a product photo», и такой
 * кадр запрещался целиком; теперь это замечание, а не запрет.
 */
const READABLE_SOFT = /\bscreen (?:showing|displaying)\b|\bproduct page\b|\blisting\b/i;
/** Предмет сам по себе не запрещён: квитанцию можно скомкать, если её не просят прочитать. */
const UNREADABLE = /\bunreadable\b|\billegible\b|\bblurred\b|\bout of focus\b|\bnot readable\b/i;

/** Движение камеры. Вместе со словом static — противоречие. */
const CAMERA_MOVES = /\b(?:pans?|tilts?|tracks?|dollies|dolly|pushes in|pulls back|moves? (?:with|toward|away)|follows?|orbits?|circles?|cranes?|zooms?)\b/i;

/** Сцена объявляет себя происходящей раньше: флешбэк в коротком ролике читается как ошибка. */
const EARLIER = /\bbefore the (?:jump|flight|fall|launch|flare|drop)\b|\bbefore he (?:jump|jumps|jumped|left|leaps|leapt|steps|stepped)\b|\bearlier that (?:day|morning|evening|week)\b|\bflashback\b|\bback (?:at home|in the room) before\b/i;

/** Поза и положение ЧЕЛОВЕКА: в состоянии предмета таких слов быть не должно. */
const PERSON_POSE = /\b(?:standing|stands|sitting|sits|kneeling|kneels|lying|lies|walking|walks|running|runs|leaning|leans|crouching|both feet|his feet|her feet|facing)\b/i;
/** Камера идёт за объектом. */
const CAMERA_FOLLOWS = /\b(?:follows?|following|tracks?|tracking|stays? (?:with|beside|level with)|keeps? pace)\b/i;
/** Видимый ориентир, по которому читается движение. */
const MOTION_REFERENCE = /\b(?:background|backdrop|trees|wall|walls|ground|horizon|rock face|cliff face|road|kerb|curb|water|shore|buildings|fence|rails?|sliding past|slides past|moves? past|passes behind|rushes past)\b/i;

/**
 * Слова процесса: предложение описывает, КАК действие происходит, а не каким кадр начинается.
 * «holds the envelope in frame as it is opened» — наблюдение за вскрытием, а не заявление,
 * что конверт уже вскрыт.
 */
const PROCESS = /\b(?:as|while|until|when|then|during|becomes?|turns? into|being|starts? to|begins? to)\b/i;

/**
 * Прямое заявление о ПЕРВОМ кадре. Только такие куски описания камеры считаются заявлением
 * начального состояния: «уже вскрытый конверт лежит в кадре с первого момента». Остальной
 * текст камеры говорит, где стоит камера, и словами сцены — «beside the workbench» не
 * означает, что предмет уже поднят над верстаком.
 */
const INITIAL_CLAIM = /\balready\b|\bfrom the (?:first|very first|opening) (?:moment|frame|second)\b|\bat the start of the (?:clip|shot)\b|\bfrom the outset\b/i;

/** Слова продолжения: состояние не меняется, а сохраняется. */
const CONTINUES = /\b(?:still|remains?|unchanged|same|again|as before|intact)\b/i;

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
const STATE_STOP = new Set(["the", "and", "his", "her", "its", "with", "into", "onto", "from", "that", "this", "for", "are", "was", "has", "have", "been"]);
/** Слова отрицания: они переворачивают смысл состояния и не могут молча выпадать. */
const STATE_NEG = new Set(["not", "no", "never", "without", "none", "nothing", "cannot"]);

/**
 * Состояние как проверяемое значение: значимые слова и знак. Раньше отрицание попадало
 * в список игнорируемых слов, поэтому «review not submitted» и «review submitted»
 * выглядели одинаково.
 */
function stateTokens(s: string): { words: Set<string>; negated: boolean } {
  const all = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return {
    words: new Set(all.filter((w) => w.length >= 3 && !STATE_STOP.has(w) && !STATE_NEG.has(w))),
    negated: all.some((w) => STATE_NEG.has(w)),
  };
}

/**
 * Слова, которыми результат ОТЛИЧАЕТСЯ от исходного состояния. Именно они доказывают, что
 * событие произошло: «phone», «review», «canopy» называют предмет разговора и есть по обе
 * стороны перехода, поэтому из проверки убираются вместе с идентификаторами.
 */
function decisiveWords(before: string, after: string, ignore: string[]): Set<string> {
  const from = stateTokens(before).words;
  const skip = new Set(ignore.flatMap((s) => [...stateTokens(s).words]));
  const out = new Set<string>();
  for (const w of stateTokens(after).words) {
    if (!from.has(w) && !skip.has(w)) out.add(w);
  }
  return out;
}

/**
 * Достигнуто ли обещанное состояние: тот же знак и хотя бы одно решающее слово результата.
 * Требовать ВСЕ слова обещания нельзя — живой английский планировщика описывает то же самое
 * другими словами, и «screen showing a typed review» переставало закрывать «screen showing
 * a typed review text being entered». Одного общего слова тоже мало, поэтому слова, общие
 * с исходным состоянием, и названия предметов в счёт не идут.
 */
function stateReached(promised: string, got: string, from = "", ignore: string[] = []): boolean {
  const want = stateTokens(promised);
  if (!want.words.size) return false;
  const have = stateTokens(got);
  if (want.negated !== have.negated) return false;
  const decisive = from || ignore.length ? decisiveWords(from, promised, ignore) : want.words;
  const check = decisive.size ? decisive : want.words;
  for (const w of check) {
    // «unsubmitted» — это не «submitted»: приставка отрицания тоже переворачивает смысл
    if (have.words.has(w) && !have.words.has(`un${w}`)) return true;
  }
  return false;
}

/**
 * Обязательство это или сохраняемое условие. Явное поле контракта сильнее догадки; без него
 * смотрим на сам переход: если состояние после по-прежнему содержит исходное («torn» →
 * «still torn and flapping»), предмет сохраняется, и показывать в нём нечего. Имена предметов
 * в проверке не участвуют вовсе — от них результат зависеть не должен.
 */
export function objectRole(o: ObjectState): "change" | "keep" {
  if (o.role === "change" || o.role === "keep") return o.role;
  const before = o.before.trim();
  const after = o.after.trim();
  if (!after) return "keep";
  if (!before) return "change";
  if (sameState(before, after)) return "keep";
  // «Остаётся тем же»: состояние после повторяет исходное целиком и лишь помечено словом
  // продолжения. «torn into strips» → «still torn into strips, flapping» — условие;
  // «in the courier's hand, sealed» → «in the merchant's hand, still sealed» — переход,
  // потому что исходное состояние повторено НЕ полностью.
  const from = stateTokens(before).words;
  const to = stateTokens(after).words;
  const repeatsAll = [...from].every((w) => to.has(w));
  return repeatsAll && CONTINUES.test(after) ? "keep" : "change";
}

/** Одно и то же состояние: те же значимые слова и тот же знак. */
function sameState(a: string, b: string): boolean {
  const x = stateTokens(a);
  const y = stateTokens(b);
  if (x.negated !== y.negated || x.words.size !== y.words.size) return false;
  for (const w of x.words) if (!y.words.has(w)) return false;
  return true;
}

/** Прежнее имя: совпадение по обещанному результату. */
function stateMatches(promised: string, got: string): boolean {
  return stateReached(promised, got);
}

/**
 * Показано ли событие. Сверяется КОНКРЕТНЫЙ обещанный переход каждого предмета события:
 * состояние до сцены похоже на обещанное «до», состояние после — на обещанное «после».
 *
 * Прежняя версия засчитывала любое изменение нужного предмета, и «достал телефон из кармана
 * и положил на стол» закрывало событие «написал отзыв». Пустой список предметов теперь не
 * закрывается произвольным keyMoment: событие без проверяемого доказательства — это дефект
 * контракта, и он обрабатывается отдельно, а не превращается в успех.
 */
export function eventCovered(event: StoryEvent, beats: StoryBeat[], shots?: FilmShot[]): boolean {
  if (!event.objects.length) return false;
  let claiming = beats.filter((b) => isAi(b) && (b.eventIds ?? []).includes(event.id));
  // С конечными запросами проверка идёт по ним, а не по намерению: бит мог остаться
  // в таймлайне, но не попасть ни в один клип (несовместимая группа), и тогда события
  // в ролике не будет. Клип обязан и содержать бит, и заявлять само событие.
  if (shots) {
    const inShots = new Set(
      shots.filter((sh) => sh.eventIds.includes(event.id)).flatMap((sh) => sh.beatIds),
    );
    claiming = claiming.filter((b) => inShots.has(b.id));
  }
  if (!claiming.length) return false;
  // Обязательства события — ВСЕ его переходы, а не тот предмет, чьё имя случайно попало
  // в английское описание. Прежний выбор «названный, иначе первый» зависел от внутренних
  // имён: сделка «деньги за чашку» под именами money/cup проверялась целиком, а под
  // payment-token/purchased-item — наполовину. Сохраняемые условия («остаётся порванным»)
  // обязательством не являются: показывать в них нечего.
  const ignore = [event.id, ...event.objects.map((o) => o.id)];
  const must = event.objects.filter((o) => objectRole(o) === "change");
  if (!must.length) return false;
  return claiming.some((b) =>
    must.every((want) => {
      const got = (b.objects ?? []).find((o) => o.id === want.id);
      if (!got) return false;
      const after = got.after.trim();
      const before = got.before.trim();
      if (!after) return false;
      // Сцена обязана что-то изменить. Неизменное состояние — это не показанное событие,
      // сколько бы слов из обещания в нём ни повторялось.
      if (before && sameState(before, after)) return false;
      // Результат уже достигнут ДО действия: «уже порванный купол колышется на ветру»
      // показывает последствие, а не сам разрыв. Добавленные слова про ветер меняют строку,
      // но не делают событие показанным.
      if (before && stateReached(want.after, before, want.before, ignore)) return false;
      // Результат сцены — именно обещанный результат, со знаком: «review not submitted»
      // не закрывает «review submitted».
      if (!stateReached(want.after, after, want.before, ignore)) return false;
      return true;
    }),
  );
}

export function auditPlan(
  beats: StoryBeat[],
  bible: StoryBible,
  character: Pick<CharacterProfile, "name" | "referenceFiles">,
  shots?: FilmShot[],
): PlanIssue[] {
  const out: PlanIssue[] = [];
  const shown = beats.filter(isAi);
  const add = (code: string, ids: string[], message: string, severity: "block" | "warn" = "warn") => {
    if (ids.length) out.push({ code, severity, beatIds: ids, message });
  };

  // Контракт событий проверяется первым: молча испорченный или пустой контракт превращал
  // непокрытый план в «зелёный», и проверка ниже подтверждала успех на пустом месте.
  const events = bible.events ?? [];
  const broken = events.filter((e) => !e.id || !e.observable || !e.objects.length);
  if (broken.length) {
    out.push({
      code: "event-contract-broken",
      severity: "block",
      beatIds: [],
      eventIds: broken.map((e) => e.id || "(без id)"),
      message:
        "Событие без проверяемого доказательства: нужны идентификатор, наблюдаемое изменение и хотя бы один предмет " +
        `с состоянием до и после (${broken.map((e) => e.id || "(без id)").join(", ")})`,
    });
  }
  // Запись, которую нормализатор не смог разобрать вовсе, раньше исчезала без следа:
  // рядом с одним исправным событием контракт выглядел целым.
  if (bible.eventsDropped) {
    out.push({
      code: "event-contract-broken",
      severity: "block",
      beatIds: [],
      message: `Записей контракта не разобрано: ${bible.eventsDropped}. Нужны идентификатор, наблюдаемое изменение и предметы с состоянием до и после`,
    });
  }
  // Пустой контракт — ошибка там, где сцены обещают совершение: заявленный переход предмета
  // или ссылка на событие. План, который осознанно показывает обстановку и результат
  // (панорама улицы, вид мастерской), обещания не даёт, и запрещать его нечем.
  const claimsChange = shown.some((b) => (b.eventIds ?? []).length > 0 || (b.objects ?? []).some((o) => objectRole(o) === "change"));
  if (!events.length && shown.length) {
    if (claimsChange) {
      out.push({
        code: "event-contract-empty",
        severity: "block",
        beatIds: [],
        message: "Сцены обещают показать изменение, но контракт событий пуст: проверить нечего",
      });
    } else {
      out.push({
        code: "no-events-declared",
        severity: "warn",
        beatIds: [],
        message: "План не обещает ни одного события: сцены показывают обстановку и результат — убедитесь, что этого достаточно",
      });
    }
  }
  // Ссылка на несуществующее событие — тоже дефект контракта, а не мелочь: сцена считает
  // себя показывающей то, чего в контракте нет.
  const known = new Set(events.map((e) => e.id));
  const dangling = shown.filter((b) => (b.eventIds ?? []).some((id) => !known.has(id)));
  add(
    "event-unknown-reference",
    dangling.map((b) => b.id),
    `Сцена ссылается на событие, которого нет в контракте (${[...new Set(dangling.flatMap((b) => (b.eventIds ?? []).filter((id) => !known.has(id))))].join(", ")})`,
    "block",
  );

  // Обязательные события. Проверяется ПОСЛЕ нормализации, группировки и сокращения бюджета:
  // именно там события пропадали незаметно.
  const missing = events.filter((e) => e.required && e.objects.length && !eventCovered(e, beats, shots));
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

  // Просьба показать читаемый текст. Учитывается ВСЯ постановка сцены: если сам предмет
  // объявлен нечитаемым в реквизите («a row of blurred handwritten words»), требования
  // разобрать надпись нет. Персонаж, читающий карточку, тоже не обязывает зрителя её читать.
  // Снятие работает адресно: нечитаемость одного предмета не отменяет требования прочитать
  // другой — у отмены и требования должно быть общее значимое слово.
  const readable = (re: RegExp) =>
    shown
      .filter((b) => {
        const demand = `${b.visualAction} ${b.keyMoment}`;
        const found = demand.match(re);
        if (!found) return false;
        // «no readable text», «without legible labels» — это ОТКАЗ от читаемости, а не
        // требование её показать. Отрицание перед совпадением снимает требование.
        const before = demand.slice(Math.max(0, (found.index ?? 0) - 24), found.index ?? 0);
        if (/\b(?:no|not|without|never|nothing)\b[^.]{0,14}$/i.test(before)) return false;
        const staging = [...(b.scene?.props ?? []), ...(b.scene?.worn ?? []), b.scene?.mechanics ?? "", b.stateBefore, b.stateAfter, demand];
        const hit = demand.match(re)?.[0] ?? "";
        const around = demand.slice(Math.max(0, demand.indexOf(hit) - 60), demand.indexOf(hit) + hit.length + 60);
        const near = stateTokens(around).words;
        return !staging.some((part) => {
          if (!UNREADABLE.test(part)) return false;
          const words = stateTokens(part).words;
          return [...words].some((w) => near.has(w));
        });
      })
      .map((b) => b.id);
  const hard = readable(READABLE_HARD);
  add("readable-text", hard, "Сцена требует читаемый текст на экране или бумаге — Veo его не выводит", "block");
  add(
    "screen-content",
    readable(READABLE_SOFT).filter((id) => !hard.includes(id)),
    "В кадре экран с содержимым: надписи на нём выйдут нечитаемыми, событие должно читаться по действию",
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
  // Повторное использование локации не доказывает возврат во времени: заказ на кухне,
  // получение на крыльце, распаковка снова на кухне — нормальная хронология. Сигнал остаётся,
  // но обязательным запретом он быть не может.
  add("location-jump-back", flash, "Действие возвращается в прежнее место через сцену — проверьте порядок событий");

  // Проверки по конечным запросам. До них разбор смотрел только на биты, и потерянная
  // сцена — бит есть в таймлайне, но ни в одном клипе его нет — выглядела как исправный план.
  if (shots) {
    const covered = new Set(shots.flatMap((sh) => sh.beatIds));
    add(
      "beat-not-in-shot",
      shown.filter((b) => !covered.has(b.id)).map((b) => b.id),
      "Сцена осталась в таймлайне, но ни в один запрос Veo не попала — на экране её не будет",
      "block",
    );
    // Якорь вне используемого отрезка клипа: срок отброшен, событие осталось без времени.
    // Это не повод требовать невозможного в промпте, но и молчать нельзя — сцену надо переставить.
    const outside = [...new Set(shots.flatMap((sh) => (sh.deadlines ?? []).filter((d) => d.beyond).map((d) => d.beatId)))];
    // Обязательное событие без выполнимого срока — это не замечание: оно должно прозвучать
    // в свою реплику, а показать его в этом клипе уже нельзя. Такую сцену надо переставить,
    // поэтому план не идёт к оплате. Для остальных достаточно предупреждения.
    const requiredIds = new Set(events.filter((e) => e.required).map((e) => e.id));
    const hard = outside.filter((id) => (beats.find((b) => b.id === id)?.eventIds ?? []).some((e) => requiredIds.has(e)));
    add(
      "anchor-outside-shot",
      outside.filter((id) => !hard.includes(id)),
      "Момент в речи приходится на отрезок, которого нет в клипе — событие останется без срока, сцену нужно переставить",
    );
    add(
      "required-anchor-outside-shot",
      hard,
      "Обязательное событие звучит позже, чем заканчивается его клип — сцену нужно переставить под свою реплику",
      "block",
    );
    // Один бит с двумя событиями получает один срок на оба: разделить их нечем, пока
    // якорь один на бит. Такую сцену планировщик должен разложить на две.
    add(
      "beat-multiple-events",
      shown.filter((b) => (b.eventIds ?? []).length > 1).map((b) => b.id),
      "В одной сцене несколько событий: у них будет общий срок, показать их по отдельности нельзя — разложите на две сцены",
    );
  }

  // Состояние предмета описывает предмет. «harness — standing at the rocky edge, both feet
  // planted on stone» описывает человека, и надетое снаряжение при этом теряется: в запрос
  // уходит поза вместо предмета. Где стоит человек — это scene.who.
  add(
    "object-state-describes-person",
    shown
      .filter((b) => (b.objects ?? []).some((o) => PERSON_POSE.test(`${o.before} ${o.after}`)))
      .map((b) => b.id),
    "Состояние предмета описывает позу человека, а не сам предмет — положение людей относится к сцене, а не к вещи",
  );

  // Фазы смешаны: сцена одновременно объявляет предмет и в исходном, и в конечном состоянии.
  // Так в одном запросе оказывались «упакован, ещё не раскрыт» и «разорванная ткань заполняет
  // верх кадра»: генератор выбирает одно из двух наугад.
  const mixed: string[] = [];
  for (const b of shown) {
    for (const o of b.objects ?? []) {
      if (!o.before.trim() || !o.after.trim() || sameState(o.before, o.after)) continue;
      // Смотрим только на то, чем кадр НАЧИНАЕТСЯ: сводку состояния и позицию камеры.
      // Предложения о ходе действия из проверки исключаются — наблюдение за вскрытием
      // не означает, что конверт вскрыт с первого кадра.
      const declared = (b.stateBefore ?? "").split(/[;,]/);
      // Из описания камеры берутся только прямые заявления о первом кадре.
      const claimed = (b.camera ?? "").split(/[;,]/).filter((c) => INITIAL_CLAIM.test(c));
      const initial = [...declared, ...claimed]
        .map((c) => c.trim())
        .filter((c) => c && !PROCESS.test(c))
        .join("; ");
      if (!initial) continue;
      // Слова места и реквизита в счёт не идут: «beside the workbench» в описании камеры
      // говорит, где стоит камера, а не что предмет уже поднят над верстаком.
      const scenery = [o.id, b.location, ...(b.scene?.props ?? []), ...(b.scene?.worn ?? []), b.scene?.who ?? ""];
      // Противоречием считается только ПОЛНОЕ заявление конечного состояния. Одно общее
      // слово ловило исправные сцены: «phone closed, cover screen lit» в начале кадра
      // совпадало с «visible lit cover display» лишь словом «lit», и раскрытие складного
      // телефона запрещалось к оплате.
      const decisive = decisiveWords(o.before, o.after, scenery);
      const said = stateTokens(initial).words;
      const claimsAfter = decisive.size > 0 && [...decisive].every((w) => said.has(w));
      if (claimsAfter && !stateReached(o.before, initial, o.after, scenery)) {
        mixed.push(`${b.id}/${o.id}`);
      }
    }
  }
  add("phase-conflict", mixed, "Сцена начинается с предмета в исходном состоянии, а камера уже описывает его конечное состояние", "block");

  // Камера сопровождает движущийся объект, но по чему видно движение — не сказано.
  // Постоянная дистанция без ориентира читается как зависание.
  add(
    "follow-without-reference",
    shown.filter((b) => CAMERA_FOLLOWS.test(b.camera) && !MOTION_REFERENCE.test(`${b.camera} ${b.motion} ${b.visualAction}`)).map((b) => b.id),
    "Камера идёт за объектом, но в кадре нет ориентира движения — скорость и перемещение не прочитаются",
  );

  // Объект идёт в объектив и одновременно должен оставаться целиком в кадре тем же размером.
  // Либо камера отступает, либо движение проходит мимо неё.
  add(
    "toward-lens-fixed-scale",
    shown
      .filter((b) => /\btoward (?:the )?camera\b|\binto the lens\b/i.test(`${b.camera} ${b.motion}`))
      .filter((b) => !CAMERA_MOVES.test(b.camera))
      .filter((b) => b.composition !== "center")
      .map((b) => b.id),
    "Объект движется в объектив, а камера неподвижна и обязана удержать масштаб — задайте отход камеры или движение мимо неё",
  );

  // Сцена, которая сама объявляет себя происходящей раньше предыдущих. В ролике на сорок
  // секунд флешбэк читается как ошибка монтажа, а не как приём: после порванного купола
  // зритель видит, как герой только надевает запасной ранец «перед прыжком».
  add(
    "scene-out-of-order",
    shown.filter((b, i) => i > 0 && EARLIER.test(`${b.visualAction} ${b.keyMoment} ${b.motion}`)).map((b) => b.id),
    "Сцена объявлена происходящей раньше предыдущих — в коротком ролике это читается как ошибка порядка",
  );

  // Сцена с героем без эталонов: лицо будет случайным.
  if (!character.referenceFiles.length) {
    add("no-references", shown.filter((b) => b.gudiniVisible).map((b) => b.id), "Сцены с героем без эталонных картинок — лицо не удержится");
  }

  return out;
}
