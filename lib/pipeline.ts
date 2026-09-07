import fs from "fs";
import os from "os";
import path from "path";
import { getProject, updateProject, projectDir, hasMusic, MUSIC_FILE, getSettings } from "./store";
import { probe, probeDuration, runFfmpeg, extractAudio, detectSilences, detectBlackNear, measureRmsWindows, type ProbeInfo } from "./ffmpeg";
import { analyzeLevel, levelGateError, analysisGainDb, transcriptGateError } from "./speechGate";
import { trackMismatchError } from "./ingestGate";
import {
  edgesFromSilences,
  mechanicalCuts,
  segmentsFromCuts,
  remapWordsWithIndex,
  remapWords,
  CutRegion,
} from "./speechCleanupPlan";
import { planSpeechCleanup } from "./speechCleanupPlanner";
import { planCleanupCuts } from "./speechCleanupRun";
import { recordFlat, AUDIO_PRICES } from "./costLedger";
import { runMontageV3 } from "./montageV3Pipeline";
import { scribeTranscribe, whisperTranscribe, alignScriptToDuration, Word } from "./transcribe";
import { fileFingerprint, textHash } from "./fileFingerprint";
import { checkRenderConformance } from "./renderConformance";
import { pauseCut } from "./speechCleanupPlan";
import { buildAss } from "./subtitles";
import { CARD, CARD_FILTER } from "./topInset";
import { applyScriptFormatting } from "./scriptFormat";
import { attachScriptPunctuation } from "./scriptPunctuation";
import { generateMeta } from "./ai";
import { buildStoryAssetPack } from "./storyAssets";
import { resetCost } from "./pipelineCost";
import { resetLedger, writeLedger, summarize } from "./costLedger";
import { formatCostReport } from "./costReport";
import { buildStoryResearchPack, StoryResearchPack } from "./storyResearch";
import { generateCoverConcept } from "./cover";
import { resolveHeadline } from "./coverHeadline";
import { buildCover } from "./coverPipeline";
import { fullAiCoverEnabled } from "./coverProvider";
import type { CoverStatus } from "./store";
import {
  EditPlan,
  EditEvent,
  DEFAULT_CAPTION_STYLE,
  coverSpeechCuts,
  visualCoverage,
  aRollGaps,
  validatePlan,
} from "./editPlan";

const overlapsEvents = (a: EditEvent, b: EditEvent) => a.start < b.end && b.start < a.end;

const running = new Set<string>();
// флаги читаются в момент вызова — тестируемо и переключаемо без пересборки модуля
const smartEditing = () => process.env.SMART_EDITING !== "false";
const smartSpeechCleanup = () => process.env.SMART_SPEECH_CLEANUP !== "false";
// новый конвейер: исследование -> медиатека истории -> монтаж только из неё
/**
 * Montage V3 — производственный монтаж. Выключается только явно: значение по
 * умолчанию включено, чтобы новый ролик не собрался старым путём по недосмотру.
 */
const montageV3 = () => process.env.MONTAGE_V3 !== "false";

const stepClock = new Map<string, { step: string; at: number }>();
/** Стадия в проект + в журнал воркера длительность предыдущей: видно, куда уходит время. */
function setStep(id: string, step: string, progress: number) {
  const prev = stepClock.get(id);
  const now = Date.now();
  if (prev && prev.step !== step) console.log(`⏱ ${prev.step}: ${((now - prev.at) / 1000).toFixed(0)} с → ${step}`);
  stepClock.set(id, { step, at: now });
  updateProject(id, { processing: { state: "running", step, progress } });
}

/**
 * Потоки x264 для итогового рендера. Кап в 4 потока появился при OOM в контейнере
 * с малой памятью; на 12 ядрах он растягивал рендер вдвое. Берём ядра минус два
 * (сайт и воркер рядом), не меньше 4 и не больше 12; RENDER_THREADS задаёт явно.
 */
function renderThreads(): number {
  const env = Number(process.env.RENDER_THREADS);
  if (Number.isFinite(env) && env >= 1) return Math.round(env);
  return Math.min(12, Math.max(4, os.cpus().length - 2));
}

/**
 * Автомонтаж 2.0 (transcript-first, EDL):
 * 1) точная длительность по аудио; 2) вырезка пауз (края + длинные внутри) с аудио-микрофейдами;
 * 3) распознавание речи; 4) ИИ-режиссёр строит EditPlan (A-roll/B-roll/punch-in/callout);
 * 5) подбор материалов (свои → Runway → сток с кэшем и ранжированием);
 * 6) детерминированный ffmpeg-рендер по плану; 7) обложка; 8) self-check результата.
 * План сохраняется в edit-plan.json. При сбое планировщика — fallback на старый конвейер.
 */
export async function processProject(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  resetCost();
  resetLedger();
  try {
    const project = getProject(id);
    if (!project) throw new Error("Проект не найден");
    if (!project.rawVideo) throw new Error("Видео ещё не загружено");

    const dir = projectDir(id);
    let raw = project.rawVideo;

    setStep(id, "Анализ видео", 3);
    let info = await probe(path.join(dir, raw));
    if (!info.hasAudio) throw new Error("В видео нет звуковой дорожки — запишите с микрофоном");

    // Запись из браузера (телесуфлёр) приводится к обычному файлу: постоянные 30 fps, честные
    // метки времени, AAC 48 кГц. Safari отдаёт mp4 с мусорной длительностью контейнера
    // (7 млн секунд) и переменной частотой кадров — на таком файле trim/concat дали чистый
    // файл на 6899 с, и рендер упал. Файлы с камеры и телефона не трогаются.
    const normalized = await normalizeBrowserRecording(dir, raw, info, (f) => setStep(id, "Подготовка записи", 3 + Math.round(f * 3)));
    if (normalized) {
      raw = normalized;
      info = await probe(path.join(dir, raw));
    }
    // Видео короче звука — кадры камеры оборвались (Safari на iPhone: 8 с видео при 87 с звука).
    // Контейнер сырой записи это скрывает, нормализованный файл — нет. Стоп до платных стадий.
    const mismatch = process.env.SPEECH_GATE === "off" ? null : trackMismatchError(info.videoDuration, info.audioDuration);
    if (mismatch) throw new Error(mismatch);

    // --- Точная длительность по аудио (метаданным webm с камеры верить нельзя) ---
    setStep(id, "Анализ звука", 6);
    await extractAudio(raw, "audio_full.wav", dir);
    const duration = (await probeDuration(path.join(dir, "audio_full.wav"))) || info.duration;

    // --- Ворота 1 (бесплатно): уровень записи. Запись с телесуфлёра на iPhone пришла
    // на −57 дБ, и конвейер узнал об этом только в режиссёре монтажа — после $1.19
    // исследования, медиатеки и визуальной проверки. Почти беззвучная запись
    // останавливается здесь; просто тихая — анализируется по усиленной копии звука
    // (детектор тишины и распознавание рассчитаны на обычный уровень; итоговый
    // рендер берёт звук из исходника и выравнивает его loudnorm как раньше).
    const rmsWindows = await measureRmsWindows("audio_full.wav", dir);
    const level = analyzeLevel(rmsWindows);
    if (rmsWindows.length) {
      console.log(`Уровень записи: ${level.loudestDb.toFixed(1)} дБ, активного звука ${level.activeSeconds} с из ${duration.toFixed(0)}, последний звук на ${level.lastActiveAt} с`);
      const levelError = levelGateError(level);
      if (levelError) throw new Error(levelError);
      const gain = analysisGainDb(level);
      if (gain > 0) {
        console.warn(`Запись тихая (${level.loudestDb.toFixed(0)} дБ): звук для анализа усилен на ${gain} дБ`);
        await runFfmpeg(["-i", "audio_full.wav", "-af", `volume=${gain}dB`, "-c:a", "pcm_s16le", "audio_full_boost.wav"], { cwd: dir });
        fs.renameSync(path.join(dir, "audio_full_boost.wav"), path.join(dir, "audio_full.wav"));
      }
    } else {
      console.warn("Уровень записи не измерен (ffmpeg astats): проверка пропущена");
    }
    const silences = await detectSilences("audio_full.wav", dir, duration);
    const edges = edgesFromSilences(silences, duration);

    // Исследование истории не зависит от речи: оно идёт параллельно с распознаванием,
    // чисткой и перекодированием, а нужно только к сборке медиатеки. Ошибка
    // обрабатывается там, где результат используется.
    const researchPromise: Promise<StoryResearchPack | null> = project.research
      ? Promise.resolve(project.research)
      : buildStoryResearchPack(project.topic, project.sourceUrl).catch((e) => {
          console.warn("Исследование истории не построено:", String(e?.message ?? e).slice(0, 160));
          return null;
        });

    // --- Распознавание речи ДО вырезки (на полном таймлайне) ---
    setStep(id, "Распознавание речи", 10);
    const wav = path.join(dir, "audio_full.wav");
    let rawWords: Word[] | null = null;
    let subtitlesSource: "scribe" | "whisper" | "script" = "script";
    // Повторный монтаж того же исходника не платит за распознавание второй раз:
    // расшифровка привязана к содержимому файла (длина, размер и отпечаток байтов).
    // Старый ключ без отпечатка принимается, чтобы уже расшифрованные проекты не
    // платили заново.
    const rawPath = path.join(dir, raw);
    const legacyAudioKey = `${duration.toFixed(2)}:${fs.statSync(rawPath).size}`;
    const audioKey = `${legacyAudioKey}:${fileFingerprint(rawPath)}`;
    const transcriptFile = path.join(dir, "transcript.json");
    let transcriptReused = false;
    try {
      const saved = fs.existsSync(transcriptFile) ? JSON.parse(fs.readFileSync(transcriptFile, "utf8")) : null;
      const keyOk = saved?.audioKey === audioKey || saved?.audioKey === legacyAudioKey;
      if (keyOk && Array.isArray(saved.words) && saved.words.length) {
        rawWords = saved.words;
        subtitlesSource = saved.source === "whisper" ? "whisper" : "scribe";
        transcriptReused = true;
        console.log(`Расшифровка переиспользована: ${rawWords!.length} слов (${subtitlesSource})`);
      }
    } catch {}
    const asrErrors: string[] = [];
    if (!rawWords) {
      // одна повторная попытка только на сетевой сбой: это копейки, а не оплаченный ответ
      for (let attempt = 1; attempt <= 2 && !rawWords; attempt++) {
        try {
          rawWords = await scribeTranscribe(wav);
          if (rawWords) subtitlesSource = "scribe";
          else {
            asrErrors.push("Scribe: не задан ключ ELEVENLABS_API_KEY");
            break;
          }
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          asrErrors.push(`Scribe: ${msg.slice(0, 160)}`);
          console.warn("Scribe недоступен:", msg);
          if (attempt === 1 && /\b(?:429|5\d\d)\b|timeout|ECONNRESET|fetch failed|socket/i.test(msg)) {
            await new Promise((r) => setTimeout(r, 3000));
          } else break;
        }
      }
    }
    if (!rawWords) {
      try {
        rawWords = await whisperTranscribe(wav);
        if (rawWords) subtitlesSource = "whisper";
        else asrErrors.push("Whisper: не задан ключ OPENAI_API_KEY");
      } catch (e: any) {
        asrErrors.push(`Whisper: ${String(e?.message ?? e).slice(0, 160)}`);
        console.warn("Whisper недоступен:", e);
      }
    }
    // Без распознавания субтитры раньше молча раскладывались по сценарию «на глаз»,
    // и оплаченный монтаж выходил с плывущими подписями. Теперь это ошибка стадии;
    // старое поведение включается явно: SUBTITLES_FROM_SCRIPT=1.
    if (!rawWords && process.env.SUBTITLES_FROM_SCRIPT !== "1") {
      throw new Error(
        `Распознавание речи не удалось: ${asrErrors.join("; ") || "нет ни одного сервиса"}. ` +
          "Субтитры по сценарию без распознавания отключены (SUBTITLES_FROM_SCRIPT=1 включает их)",
      );
    }
    if (rawWords && !transcriptReused) {
      // Пословная расшифровка сохраняется: без неё чистку речи нельзя перепланировать,
      // не заплатив за распознавание второй раз, а субтитры пришлось восстанавливать
      // из фраз. Стоимость распознавания — в леджер, по минутам звука.
      fs.writeFileSync(
        transcriptFile,
        JSON.stringify({ source: subtitlesSource, audioKey, createdAt: new Date().toISOString(), words: rawWords }, null, 2),
        "utf8",
      );
      const asrModel = subtitlesSource === "scribe" ? "elevenlabs/scribe" : "openai/whisper-1";
      recordFlat({
        stage: "Transcription",
        provider: subtitlesSource === "scribe" ? "elevenlabs" : "openai",
        model: asrModel,
        cost: (AUDIO_PRICES[asrModel] ?? 0) * (duration / 60),
        estimated: true,
      });
    }

    // --- Ворота 2 (бесплатно): распознанной речи должно хватать на сценарий. Иначе
    // чистка речи, биты, медиатека и визуальная проверка оплачиваются ради ролика,
    // который режиссёр всё равно отклонит. Расшифровка уже сохранена — повторный
    // запуск того же файла её не оплачивает.
    if (rawWords) {
      const transcriptError = transcriptGateError(rawWords, duration, project.script);
      if (transcriptError) throw new Error(transcriptError);
    }

    // --- Speech Cleanup: запинки/повторы/фальстарты + умные паузы (только при реальном ASR) ---
    setStep(id, "Чистка речи", 16);
    let cuts: CutRegion[] | null = null;
    if (rawWords && smartSpeechCleanup()) {
      // План чистки зависит от расшифровки и сценария: если они те же, что в прошлый
      // раз, план берётся из файла — два вызова модели не оплачиваются повторно.
      const planFile = path.join(dir, "speech-cleanup-plan.json");
      // ключ по тексту сценария, а не по его длине: правка той же длины давала старые вырезки
      const cleanupKey = `${audioKey}:${textHash(project.script ?? "")}:${rawWords.length}`;
      const legacyCleanupKey = `${legacyAudioKey}:${(project.script ?? "").length}:${rawWords.length}`;
      let reusedPlan: { actions: any[] } | null = null;
      try {
        const saved = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, "utf8")) : null;
        const keyOk = saved?.cleanupKey === cleanupKey || saved?.cleanupKey === legacyCleanupKey;
        if (keyOk && Array.isArray(saved.actions)) reusedPlan = saved;
      } catch {}
      if (reusedPlan) {
        cuts = reusedPlan.actions.map((a: any) =>
          a.type === "REMOVE_FRAGMENT" ? { start: a.start, end: a.end } : pauseCut(a.start, a.end, a.keepDuration),
        );
        console.log(`План чистки речи переиспользован: ${reusedPlan.actions.length} действий`);
      } else {
        try {
          const run = await planCleanupCuts({ script: project.script, words: rawWords, silences, edges, duration, log: (l) => console.log(l) });
          cuts = run.cuts;
          fs.writeFileSync(planFile, JSON.stringify({ version: 1, cleanupKey, actions: run.actions }, null, 2), "utf8");
        } catch (e) {
          console.warn("Speech cleanup недоступен, работаем без него:", e);
        }
      }
    }
    if (!cuts) cuts = mechanicalCuts(silences, edges); // фолбэк без расшифровки: только механические паузы

    const segments = segmentsFromCuts(edges, cuts);
    const effDur = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

    // --- Чистый исходник: склейка сегментов с аудио-микрофейдами на границах ---
    let source = raw;
    if (segments.length > 1) {
      setStep(id, `Вырезка (${segments.length - 1} склеек)`, 20);
      await buildCleanSource(dir, raw, segments);
      source = "clean.mp4";
    } else if (segments[0].start > 0.05 || segments[0].end < duration - 0.05) {
      setStep(id, "Обрезка краёв", 20);
      await runFfmpeg(
        [
          "-ss", String(segments[0].start), "-t", String(segments[0].end - segments[0].start),
          "-i", raw,
          "-vf", authorFitFilter(info.displayWidth, info.displayHeight),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
          "-c:a", "aac", "-b:a", "192k",
          "clean.mp4",
        ],
        { cwd: dir, totalDurationSec: effDur },
      );
      source = "clean.mp4";
    }

    // --- Слова на чистом таймлайне: пересчёт таймкодов (вырезанное выпадает и из субтитров) ---
    let words: Word[];
    if (rawWords) {
      words = remapWords(rawWords, segments);
    } else {
      if (!project.script) throw new Error("Нет ни распознавания речи, ни сценария для субтитров");
      words = alignScriptToDuration(project.script, effDur);
    }
    // каноническая запись из сценария: «18» → «1/8», «5000» → «$5000», имена с большой буквы
    words = applyScriptFormatting(words, project.script);
    // границы предложений, знаки и ключевые слова — из сценария: субтитры режутся по смыслу
    words = attachScriptPunctuation(words, project.script);

    // --- Метаданные (нужны до обложки) ---
    setStep(id, "Описание и хэштеги", 20);
    let meta = getProject(id)?.meta ?? null;
    if (!meta) {
      try {
        meta = (await generateMeta(project.topic, project.script ?? "")).meta;
      } catch (e) {
        console.warn("Метаданные не сгенерировались:", e);
        meta = { title: project.topic, description: "", hashtags: [] };
      }
    }

    // --- Монтажный план: ИИ-режиссёр → валидация → материалы; fallback — старый конвейер ---
    setStep(id, "Режиссёрский план", 24);
    let plan: EditPlan | null = null;
    // точки видимых склеек на чистом таймлайне — планировщик постарается их накрыть
    const seamPoints = segments
      .slice(1)
      .map((_, i) => segments.slice(0, i + 1).reduce((sum, x) => sum + (x.end - x.start), 0))
      .filter((t) => t > 0.5 && t < effDur - 0.5);
    // НОВЫЙ ПУТЬ: медиатека истории собирается ДО монтажа, планировщик выбирает
    // только из неё. Отката на слепой поиск по фразам здесь нет: если путь не
    // отработал, ролик выходит без перебивок, а причина видна в логе.
    // ПРОИЗВОДСТВЕННЫЙ ПУТЬ V3: история → блоки сценария → медиатека → режиссёр → валидатор.
    // Отката на старый планировщик нет ни на одном шаге: молчаливая подмена монтажа
    // однажды уже дала ролик, собранный непонятно чем, и разбираться было дороже.
    if (montageV3()) {
      let research = getProject(id)?.research;
      if (!research) {
        // Сценарий написан обычной генерацией по теме, без исследования. Медиатека
        // без фактов и источников не собирается; исследование запущено в начале
        // задачи параллельно с речью, здесь оно дожидается и сохраняется в проект —
        // повторный монтаж его уже не оплачивает.
        setStep(id, "Исследование истории", 24);
        research = (await researchPromise) ?? undefined;
        if (!research) {
          throw new Error(
            "Montage V3: исследование истории не построено (нет источников или ключа поиска). " +
              "Монтаж без проверенных фактов не собирается.",
          );
        }
        updateProject(id, { research });
        console.log(`Исследование истории построено: сущностей ${research.entities.length}, фактов ${research.facts.length}`);
      }
      setStep(id, "Блоки сценария и медиатека", 26);
      const v3 = await runMontageV3({
        research,
        script: project.script ?? "",
        words,
        duration: effDur,
        dir,
        speechCuts: seamPoints,
      });
      console.log(
        `Montage V3: блоков ${v3.beats.length}${v3.beatsReused ? " (переиспользованы)" : ""}, материалов ${v3.pack.assets.length} ` +
          `(медиатека ${v3.packReused ? "переиспользована — поиск и зрение не оплачивались" : "собрана заново"}), ` +
          `вставок ${v3.montage.events.length}, покрытие ${(v3.montage.stats.externalCoverage * 100).toFixed(0)}%`,
      );
      for (const w of v3.warnings) console.warn(`  предупреждение: ${w}`);

      setStep(id, "Режиссёрский план", 30);
      plan = v3.plan;
      fs.writeFileSync(path.join(dir, "montage-plan.json"), JSON.stringify(v3.montage, null, 2), "utf8");
      fs.writeFileSync(path.join(dir, "edit-plan.json"), JSON.stringify(plan, null, 2), "utf8");
    } else {
      // Старый монтаж из production удалён намеренно. Он подбирал перебивки
      // по фразам без проверки фактов, и включить его «на время» означало бы
      // однажды выпустить ролик, собранный не той системой, и не понять этого.
      throw new Error(
        "MONTAGE_V3=false: производственный монтаж отключён, а старого пути больше нет. " +
          "Включите Montage V3 или остановите задачу.",
      );
    }

    // --- Субтитры (единственный текстовый слой в ролике) ---
    setStep(id, "Субтитры", 34);
    fs.writeFileSync(path.join(dir, "subs.ass"), buildAss(words, plan.captionStyle), "utf8");
    fs.rmSync(path.join(dir, "callouts.ass"), { force: true }); // от прошлых прогонов

    // --- Рендер по плану ---
    setStep(id, "Монтаж видео", 38);
    await renderPlan(dir, source, plan, effDur, (f) =>
      setStep(id, "Монтаж видео", 38 + Math.round(f * 52)),
    );

    // --- Обложка: ТОЛЬКО Full-AI (Gemini Flash рисует всё) + QC. Фолбэков нет:
    // не прошла QC за 3 попытки → COVER_FAILED и кнопка «Перегенерировать» в интерфейсе.
    setStep(id, "Обложка", 92);
    const { cover, coverStatus } = await makeCover(dir, project.topic, project.script, meta.title);

    // --- Self-check результата (+ чёрные кадры вокруг монтажных точек) ---
    setStep(id, "Проверка результата", 97);
    const checkPoints = [
      ...plan.events.filter((e) => e.type === "B_ROLL").flatMap((e) => [e.start, e.end]),
      ...segments.slice(1).map((_, i) => segments.slice(0, i + 1).reduce((s, x) => s + (x.end - x.start), 0)),
    ].filter((t) => t > 0.2 && t < effDur - 0.2);
    await selfCheck(dir, effDur, checkPoints);

    // --- Сверка готового файла с планом: в области карточки действительно запланированная
    // картинка, автор под ней не перекрыт, карточка неподвижна. Раньше проверка жила
    // только в ручных скриптах, и в продакшене ролик выходил без неё. Всё локально
    // (ffmpeg и арифметика), ни одного платного вызова. RENDER_CONFORMANCE=off отключает.
    if (process.env.RENDER_CONFORMANCE !== "off") {
      setStep(id, "Сверка с планом", 98);
      const conf = await checkRenderConformance(dir, path.join(dir, "out.mp4"), plan);
      fs.writeFileSync(path.join(dir, "conformance.json"), JSON.stringify(conf, null, 2), "utf8");
      console.log(
        `Сверка с планом: ${conf.passed}/${conf.expected} точек PASS, провалов ${conf.failed}, ошибок ${conf.errored}, секунд без карточки ${conf.gaps.length}`,
      );
      // единичные расхождения хэшей терпимы, массовые и ошибки проверки — нет
      const tolerated = Math.max(2, Math.ceil(conf.expected * 0.15));
      if (conf.errored > 0 || conf.failed > tolerated) {
        const reasons = conf.points
          .filter((pt) => pt.status !== "PASS")
          .slice(0, 3)
          .map((pt) => `${pt.at}с ${pt.assetFile}: ${pt.reason ?? "не совпало"}`)
          .join("; ");
        throw new Error(`Сверка с планом: провалов ${conf.failed}, ошибок ${conf.errored} из ${conf.expected} точек — ${reasons}`);
      }
    }

    // Деньги: леджер реальных вызовов (модель, токены, цена) пишется в pipeline-cost.json
    // и печатается в лог воркера. Старые счётчики не видели вызовов через mediaLlm и
    // показывали «LLM 0» при реально оплаченной чистке речи.
    writeLedger(dir);
    keepRunLedger(dir, "done");
    console.log(formatCostReport({ title: "COST OF THIS RUN", includeHistoricalCover: true, dataDir: path.resolve(dir, "..", "..") }));
    console.log(`Стоимость прогона (переменные API): $${summarize().totals.variableApiCost.toFixed(4)}`);

    updateProject(id, {
      processedVideo: "out.mp4",
      subtitlesSource,
      cover,
      coverStatus,
      brollCount: plan.events.filter((e) => e.type === "B_ROLL").length,
      meta,
      processing: { state: "done", step: "Готово", progress: 100 },
    });
  } catch (e: any) {
    updateProject(id, {
      processing: { state: "error", step: "Ошибка", progress: 0, error: String(e?.message ?? e) },
    });
    // Неудачный прогон тоже стоил денег — леджер сохраняется, копия остаётся
    // навсегда, и печатается полный отчёт по стадиям, а не одна цифра: после
    // провала на $1.55 разбор по стадиям пришлось восстанавливать по памяти.
    try {
      writeLedger(projectDir(id));
      keepRunLedger(projectDir(id), "failed");
      console.log(formatCostReport({ title: "COST OF THIS (FAILED) RUN", includeHistoricalCover: false, dataDir: path.resolve(projectDir(id), "..", "..") }));
      console.log(`Стоимость неудачного прогона (переменные API): $${summarize().totals.variableApiCost.toFixed(4)}`);
    } catch {}
  } finally {
    running.delete(id);
  }
}

/**
 * Единственный способ получить обложку: одна генерация Gemini Flash + QC.
 * Автоматических повторов нет — при провале обложки просто нет (COVER_FAILED),
 * новую оплаченную генерацию создаёт только нажатие «Перегенерировать».
 */
export async function makeCover(
  dir: string,
  topic: string,
  script: string | null,
  title?: string | null,
  headlineOverride?: string | null,
  manual = false,
): Promise<{ cover: string | null; coverStatus: CoverStatus }> {
  // FULL_AI_COVER=false — обложки просто НЕ создаются (это выключатель, а не фолбэк
  // на другой способ: подменных обложек в системе не существует)
  if (!fullAiCoverEnabled()) {
    console.log("Cover: FULL_AI_COVER=false — генерация обложек выключена");
    return { cover: null, coverStatus: "failed" };
  }
  if (!getSettings().openrouterKey) {
    console.warn("Cover: нет ключа OPENROUTER — обложка не создаётся");
    return { cover: null, coverStatus: "failed" };
  }
  // при повторном монтаже готовая обложка переиспользуется: сюжет и заголовок те же,
  // а генерация стоит денег. Пересоздать её можно кнопкой «Перегенерировать».
  if (!manual && fs.existsSync(path.join(dir, "cover.jpg"))) {
    console.log("Cover: обложка уже есть — повторная генерация не нужна");
    return { cover: "cover.jpg", coverStatus: "ok" };
  }
  try {
    const override = headlineOverride?.trim();
    // ШЛЮЗ: до платной картинки заголовок обязан пройти semantic preflight.
    // Текстовые попытки почти бесплатны, поэтому при потере смысла просим новые
    // варианты, а не оплачиваем картинку с заведомо слабым заголовком.
    const resolved = await resolveHeadline(
      async (_attempt, strictNote) => {
        const concept = await generateCoverConcept(topic, script, title, strictNote);
        if (concept && override) concept.headlineCandidates = [override]; // выбор пользователя
        return concept;
      },
      dir,
      { ignoreAnchor: !!override },
    );

    if (!resolved.ok || !resolved.concept) {
      if (!resolved.concept) {
        console.warn("Cover: INVALID_CONCEPT — концепт не сгенерировался/не распарсился");
        return { cover: null, coverStatus: "failed" };
      }
      console.warn(
        `Cover: HEADLINE_FAILED — за ${resolved.attempts} текстовые попытки заголовок так и не сохранил ` +
          `предмет ролика (${resolved.concept.headlineAnchor?.join(", ") ?? "—"}); картинка НЕ заказывалась`,
      );
      return { cover: null, coverStatus: "headline_failed" };
    }

    const concept = resolved.concept;
    const preflight = resolved.selection!;
    console.log(
      `Cover preflight (попыток: ${resolved.attempts}): ` +
        `${preflight.headlineCandidates.map((h, i) => `«${h}» ${preflight.scores[i].score}`).join(" | ")} → «${preflight.selectedHeadline}»`,
    );
    fs.writeFileSync(path.join(dir, "cover-concept.json"), JSON.stringify(concept, null, 2), "utf8");
    const r = await buildCover(dir, concept, {}, { manual });
    console.log(
      `Cover: status=${r.status} qc=${r.qc} generations=1 cost=$${r.cost.total}${manual ? " (ручная перегенерация)" : ""}`,
    );
    return r.ok ? { cover: r.file ?? null, coverStatus: "ok" } : { cover: null, coverStatus: "failed" };
  } catch (e: any) {
    console.warn("Cover:", String(e?.message ?? e).slice(0, 200));
    return { cover: null, coverStatus: "failed" };
  }
}

/** Склейка сегментов речи в чистый исходник; на каждой границе — аудиофейды 15 мс (без щелчков). */
/** Копия леджера каждого прогона: pipeline-cost.json перезаписывается, история — нет. */
function keepRunLedger(dir: string, status: "done" | "failed"): void {
  try {
    const runs = path.join(dir, "cost-runs");
    fs.mkdirSync(runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(path.join(dir, "pipeline-cost.json"), path.join(runs, `${stamp}-${status}.json`));
  } catch {}
}

/**
 * Нужна ли записи нормализация: webm из Chrome, mp4 из Safari с мусорной длительностью
 * контейнера или переменной частотой кадров. Обычный файл с камеры/телефона: длительность
 * разумная, частота 24–120 — остаётся как есть.
 */
function looksLikeBrowserRecording(raw: string, info: ProbeInfo): boolean {
  const ext = path.extname(raw).toLowerCase();
  if (ext === ".webm" || ext === ".mkv") return true;
  if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 6 * 3600) return true;
  if (info.fps > 0 && (info.fps < 10 || info.fps > 121)) return true;
  return false;
}

/**
 * Приводит запись из браузера к обычному файлу raw-norm.mp4: постоянные 30 fps, метки
 * времени заново (+genpts), звук выровнен по времени и в 48 кГц. Делается один раз: пока
 * исходник не менялся, готовый файл переиспользуется. Возвращает имя файла или null,
 * если нормализация не нужна.
 */
export async function normalizeBrowserRecording(
  dir: string,
  raw: string,
  info: ProbeInfo,
  onProgress?: (f: number) => void,
): Promise<string | null> {
  if (!looksLikeBrowserRecording(raw, info)) return null;
  const out = "raw-norm.mp4";
  const src = fs.statSync(path.join(dir, raw));
  const stamp = `${src.size}:${src.mtimeMs}`;
  const stampFile = path.join(dir, out + ".stamp");
  if (fs.existsSync(path.join(dir, out)) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp) return out;
  console.log(`Запись из браузера: ${raw} (${info.duration.toFixed(1)} с по контейнеру, ${info.fps.toFixed(2)} fps) — нормализую в ${out}`);
  const audioSec = (await probeDuration(path.join(dir, "audio_full.wav")).catch(() => 0)) || 0;
  await runFfmpeg(
    [
      "-fflags", "+genpts",
      "-i", raw,
      "-vf", "fps=30",
      "-fps_mode", "cfr",
      "-af", "aresample=async=1:first_pts=0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-b:a", "192k",
      "-movflags", "+faststart",
      out,
    ],
    { cwd: dir, totalDurationSec: audioSec || undefined, onProgress },
  );
  fs.writeFileSync(stampFile, stamp, "utf8");
  return out;
}

/**
 * Геометрия кадра автора: весь кадр целиком, никакой обрезки. Вертикальный исходник 9:16
 * (телефон) просто масштабируется — 1:1 с тем, что снято. Любой другой (веб-камера,
 * горизонтальная съёмка, 4:3) вписывается целиком, а поля заливаются размытой копией кадра —
 * тот же приём, что у карточек в brollEntity. Раньше центр вырезался до 9:16, и веб-камера
 * давала «зум ×3», которого автор в превью не видел.
 */
export function authorFitFilter(displayWidth: number, displayHeight: number): string {
  const target = 1080 / 1920;
  const ratio = displayWidth > 0 && displayHeight > 0 ? displayWidth / displayHeight : target;
  if (Math.abs(ratio - target) / target < 0.02) return "scale=1080:1920:flags=lanczos,setsar=1";
  return (
    "split[fitbg][fitfg];" +
    "[fitbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.12:saturation=0.75[fitbgb];" +
    "[fitfg]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fitfgs];" +
    "[fitbgb][fitfgs]overlay=(W-w)/2:(H-h)/2,setsar=1"
  );
}

export async function buildCleanSource(
  dir: string,
  raw: string,
  segments: { start: number; end: number }[],
): Promise<void> {
  const src = await probe(path.isAbsolute(raw) ? raw : path.join(dir, raw));
  const fit = authorFitFilter(src.displayWidth, src.displayHeight);
  const parts: string[] = [];
  const labels: string[] = [];
  segments.forEach((seg, i) => {
    const dur = seg.end - seg.start;
    const fadeOutStart = Math.max(0, dur - 0.015);
    parts.push(
      `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=0.015,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.015[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  // Чистый файл сразу в 1080×1920: выход всё равно такой, а 4K-исходник иначе
  // перекодировался бы в 4K (4 минуты, 870 МБ) и рендер читал бы 4K-кадры.
  // Уменьшение то же, что в рендере, только на шаг раньше; по пикселям результат
  // не отличается. Исходник raw.mp4 остаётся нетронутым.
  const graph =
    parts.join(";") +
    `;${labels.join("")}concat=n=${segments.length}:v=1:a=1[vc][a];[vc]${fit}[v]`;

  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  await runFfmpeg(
    [
      "-i", raw,
      "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "clean.mp4",
    ],
    { cwd: dir, totalDurationSec: total },
  );
}

/** Детерминированный рендер EditPlan: базовый кадр → б-роллы → субтитры. */
export async function renderPlan(
  dir: string,
  source: string,
  plan: EditPlan,
  effDur: number,
  onProgress: (f: number) => void,
): Promise<void> {
  const music = hasMusic();
  const brolls = plan.events.filter((e) => e.type === "B_ROLL" && e.file);
  // источник — clean.mp4 (уже 1080×1920) или raw без склеек: в обоих случаях кадр целиком, без обрезки
  const src = await probe(path.isAbsolute(source) ? source : path.join(dir, source));
  const fit = authorFitFilter(src.displayWidth, src.displayHeight);

  // Запись телесуфлёра уже содержит выбранный пользователем кадр 9:16.
  // Сохраняем его границы на всём таймлайне: никаких скрытых приближений после записи.
  // Загрузки другого формата по-прежнему вписываются целиком через authorFitFilter.
  let chain = `[0:v]${fit},fps=30[vbase]`;
  let current = "vbase";

  // Верхняя карточка — только неподвижная картинка, всегда одного размера и
  // в одном месте. Видеофайл сюда попасть не может: материал приводится к
  // картинке ещё при сборке медиатеки.
  const isStill = (f: string) => /\.(jpe?g|png|webp|bmp)$/i.test(f);
  for (const b of brolls) {
    if (!isStill(b.file!)) {
      throw new Error(`Верхняя карточка принимает только изображения, получен ${path.basename(b.file!)}`);
    }
  }

  brolls.forEach((b, k) => {
    const inputIdx = (music ? 2 : 1) + k;
    const clipDur = (b.end - b.start).toFixed(3);
    chain +=
      `;[${inputIdx}:v]${CARD_FILTER},fps=30,` +
      `trim=duration=${clipDur},setpts=PTS-STARTPTS+${b.start.toFixed(3)}/TB[bv${k}]` +
      `;[${current}][bv${k}]overlay=${CARD.x}:${CARD.y}:eof_action=pass:enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})'[vo${k}]`;
    current = `vo${k}`;
  });

  chain += `;[${current}]ass=subs.ass[v]`;

  // Голос: лёгкое подавление шума до выравнивания громкости (loudnorm поднимает тихую
  // запись на 10–15 дБ и вместе с ней шум комнаты), затем возврат к 48 кГц — loudnorm
  // отдаёт 192 кГц, и без aresample ролик кодировался в AAC 96 кГц с шипением.
  const voice = "afftdn=nr=10:nf=-45:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";
  const audioChain = music
    ? `[0:a]${voice}[vo];` +
      `[1:a]volume=0.22,aresample=48000[mus];` +
      `[mus][vo]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];` +
      `[vo][duck]amix=inputs=2:duration=first:normalize=0[a]`
    : `[0:a]${voice}[a]`;

  await runFfmpeg(
    [
      "-i", source,
      ...(music ? ["-stream_loop", "-1", "-i", MUSIC_FILE] : []),
      // картинка — один кадр; без зацикливания overlay показал бы её 1/30 секунды
      ...brolls.flatMap((b) => ["-loop", "1", "-framerate", "30", "-t", (b.end - b.start).toFixed(3), "-i", b.file!]),
      "-filter_complex", `${chain};${audioChain}`,
      "-map", "[v]", "-map", "[a]",
      "-threads", String(renderThreads()),
      // CRF 18 / medium вместо 21 / veryfast: ~8–9 Мбит/с на 1080×1920 — запас под
      // пережатие площадками; рендер дольше на десятки секунд, денег не стоит
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-ar", "48000", "-b:a", "192k",
      "-movflags", "+faststart",
      ...(music ? ["-shortest"] : []),
      "out.mp4",
    ],
    { cwd: dir, totalDurationSec: effDur, onProgress },
  );
}

/**
 * Проверка результата: файл/потоки/длительность/разрешение/fps/синхронность аудио,
 * плюс blackdetect в маленьких окнах вокруг монтажных точек (склейки, границы б-роллов).
 */
async function selfCheck(dir: string, expectedDur: number, cutPoints: number[] = []): Promise<void> {
  const out = path.join(dir, "out.mp4");
  if (!fs.existsSync(out) || fs.statSync(out).size < 100_000) {
    throw new Error("Проверка: итоговый файл пустой");
  }
  const info = await probe(out);
  if (Math.abs(info.duration - expectedDur) > 1.5) {
    throw new Error(
      `Проверка: длительность ${info.duration.toFixed(1)}с вместо ожидаемых ${expectedDur.toFixed(1)}с`,
    );
  }
  if (info.width !== 1080 || info.height !== 1920) {
    throw new Error(`Проверка: разрешение ${info.width}×${info.height} вместо 1080×1920`);
  }
  if (!info.hasAudio) throw new Error("Проверка: в результате нет звука");
  // длительность контейнера берётся по самой длинной дорожке: видео на 8.7 с при звуке
  // на 73 с проходило как «73 с», и ролик с застывшим кадром ловила только сверка с планом
  if (info.videoDuration > 0 && info.videoDuration < expectedDur - 1.5) {
    throw new Error(
      `Проверка: видеодорожка ${info.videoDuration.toFixed(1)}с при звуке ${info.audioDuration.toFixed(1)}с — кадры исходника оборвались`,
    );
  }
  if (Math.abs(info.fps - 30) > 1) throw new Error(`Проверка: fps ${info.fps.toFixed(2)} вместо ~30`);
  if (info.audioDuration > 0 && Math.abs(info.audioDuration - info.duration) > 1.0) {
    throw new Error(
      `Проверка: аудио ${info.audioDuration.toFixed(1)}с рассинхронизировано с видео ${info.duration.toFixed(1)}с`,
    );
  }
  // чёрные кадры у монтажных точек (до 12 точек, окна по 0.3с — дёшево)
  for (const t of cutPoints.slice(0, 12)) {
    if (await detectBlackNear("out.mp4", dir, t)) {
      throw new Error(`Проверка: чёрный кадр у монтажной точки ${t.toFixed(2)}с`);
    }
  }
}
