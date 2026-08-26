import fs from "fs";
import path from "path";
import { getProject, updateProject, projectDir, hasMusic, MUSIC_FILE } from "./store";
import {
  probe,
  probeDuration,
  runFfmpeg,
  extractAudio,
  detectSilences,
  buildKeepSegments,
} from "./ffmpeg";
import { scribeTranscribe, whisperTranscribe, alignScriptToDuration, Word } from "./transcribe";
import { buildAss, buildCalloutsAss } from "./subtitles";
import { generateMeta } from "./ai";
import { prepareBroll, resolveBrollEvents } from "./broll";
import { planEdit } from "./editPlanner";
import { generateCoverConcept, generateAiCover } from "./cover";
import { EditPlan, EditEvent, DEFAULT_CAPTION_STYLE } from "./editPlan";

const running = new Set<string>();
const SMART_EDITING = process.env.SMART_EDITING !== "false";

function setStep(id: string, step: string, progress: number) {
  updateProject(id, { processing: { state: "running", step, progress } });
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
  try {
    const project = getProject(id);
    if (!project) throw new Error("Проект не найден");
    if (!project.rawVideo) throw new Error("Видео ещё не загружено");

    const dir = projectDir(id);
    const raw = project.rawVideo;

    setStep(id, "Анализ видео", 3);
    const info = await probe(path.join(dir, raw));
    if (!info.hasAudio) throw new Error("В видео нет звуковой дорожки — запишите с микрофоном");

    // --- Точная длительность по аудио (метаданным webm с камеры верить нельзя) ---
    setStep(id, "Вырезка пауз", 6);
    await extractAudio(raw, "audio_full.wav", dir);
    const duration = (await probeDuration(path.join(dir, "audio_full.wav"))) || info.duration;

    // --- Сегменты речи: края + вырезка длинных пауз внутри ---
    const silences = await detectSilences("audio_full.wav", dir, duration);
    const segments = buildKeepSegments(silences, duration);
    const effDur = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

    // --- Чистый исходник: склейка сегментов с аудио-микрофейдами на границах ---
    let source = raw;
    if (segments.length > 1) {
      setStep(id, `Вырезка пауз (${segments.length - 1} склеек)`, 9);
      await buildCleanSource(dir, raw, segments);
      source = "clean.mp4";
    } else {
      // одна непрерывная часть — просто перекодируем края позже через -ss/-t? нет:
      // для единообразия дальнейший рендер всегда работает от 0, поэтому тоже режем.
      if (segments[0].start > 0.05 || segments[0].end < duration - 0.05) {
        setStep(id, "Обрезка краёв", 9);
        await runFfmpeg(
          [
            "-ss", String(segments[0].start), "-t", String(segments[0].end - segments[0].start),
            "-i", raw,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "clean.mp4",
          ],
          { cwd: dir, totalDurationSec: effDur },
        );
        source = "clean.mp4";
      }
    }

    // --- Распознавание речи на чистом таймлайне ---
    setStep(id, "Распознавание речи", 14);
    const wav = path.join(dir, "audio.wav");
    await extractAudio(source, "audio.wav", dir);

    let words: Word[] | null = null;
    let subtitlesSource: "scribe" | "whisper" | "script" = "script";
    try {
      words = await scribeTranscribe(wav);
      if (words) subtitlesSource = "scribe";
    } catch (e) {
      console.warn("Scribe недоступен:", e);
    }
    if (!words) {
      try {
        words = await whisperTranscribe(wav);
        if (words) subtitlesSource = "whisper";
      } catch (e) {
        console.warn("Whisper недоступен:", e);
      }
    }
    if (!words) {
      if (!project.script) throw new Error("Нет ни распознавания речи, ни сценария для субтитров");
      words = alignScriptToDuration(project.script, effDur);
    }

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
    if (SMART_EDITING) {
      try {
        plan = await planEdit(project.topic, project.script, words, effDur);
      } catch (e) {
        console.warn("Планировщик упал, fallback:", e);
      }
    }
    if (plan) {
      setStep(id, "Подбор перебивок", 28);
      plan.events = await resolveBrollEvents(dir, plan.events);
    } else {
      // старый путь: только б-роллы по эвристике/простому плану
      setStep(id, "Подбор перебивок", 28);
      const clips = await prepareBroll(dir, words, project.topic).catch(() => []);
      plan = {
        version: 1,
        duration: effDur,
        captionStyle: { ...DEFAULT_CAPTION_STYLE },
        events: clips.map((c) => ({
          type: "B_ROLL" as const,
          start: c.start,
          end: c.end,
          query: c.query,
          file: c.file,
        })),
      };
    }
    fs.writeFileSync(path.join(dir, "edit-plan.json"), JSON.stringify(plan, null, 2), "utf8");

    // --- Субтитры и текстовые акценты ---
    setStep(id, "Субтитры", 34);
    fs.writeFileSync(path.join(dir, "subs.ass"), buildAss(words, plan.captionStyle), "utf8");
    const callouts = plan.events.filter((e) => e.type === "TEXT_CALLOUT");
    if (callouts.length) {
      fs.writeFileSync(path.join(dir, "callouts.ass"), buildCalloutsAss(callouts), "utf8");
    }

    // --- Рендер по плану ---
    setStep(id, "Монтаж видео", 38);
    await renderPlan(dir, source, plan, effDur, (f) =>
      setStep(id, "Монтаж видео", 38 + Math.round(f * 52)),
    );

    // --- Обложка: ИИ-key-art с reference-лицом; фолбэк — кадр из видео ---
    setStep(id, "Обложка", 92);
    const coverOffset = Math.min(Math.max(1, effDur * 0.25), Math.max(0.1, effDur - 0.2));
    let cover: string | null = null;
    try {
      const concept = await generateCoverConcept(project.topic, project.script, meta.title);
      if (concept) {
        fs.writeFileSync(path.join(dir, "cover-concept.json"), JSON.stringify(concept, null, 2), "utf8");
        if (await generateAiCover(dir, concept)) cover = "cover.jpg";
      }
    } catch (e) {
      console.warn("ИИ-обложка не сгенерировалась, фолбэк на кадр:", e);
    }
    if (!cover) {
      try {
        fs.writeFileSync(path.join(dir, "cover.ass"), buildCoverAss(meta.title || project.topic), "utf8");
        await runFfmpeg(
          ["-ss", String(coverOffset), "-i", "out.mp4", "-frames:v", "1", "-vf", "ass=cover.ass", "-q:v", "2", "cover.jpg"],
          { cwd: dir },
        );
        cover = "cover.jpg";
      } catch (e) {
        console.warn("Обложка не сгенерировалась:", e);
      }
    }

    // --- Self-check результата ---
    setStep(id, "Проверка результата", 97);
    await selfCheck(dir, effDur);

    updateProject(id, {
      processedVideo: "out.mp4",
      subtitlesSource,
      cover,
      coverOffsetSec: coverOffset,
      brollCount: plan.events.filter((e) => e.type === "B_ROLL").length,
      meta,
      processing: { state: "done", step: "Готово", progress: 100 },
    });
  } catch (e: any) {
    updateProject(id, {
      processing: { state: "error", step: "Ошибка", progress: 0, error: String(e?.message ?? e) },
    });
  } finally {
    running.delete(id);
  }
}

/** Склейка сегментов речи в чистый исходник; на каждой границе — аудиофейды 15 мс (без щелчков). */
async function buildCleanSource(
  dir: string,
  raw: string,
  segments: { start: number; end: number }[],
): Promise<void> {
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
  const graph =
    parts.join(";") + `;${labels.join("")}concat=n=${segments.length}:v=1:a=1[v][a]`;

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

/** Детерминированный рендер EditPlan: базовый кадр → punch-in → б-роллы → субтитры → callouts. */
async function renderPlan(
  dir: string,
  source: string,
  plan: EditPlan,
  effDur: number,
  onProgress: (f: number) => void,
): Promise<void> {
  const music = hasMusic();
  const brolls = plan.events.filter((e) => e.type === "B_ROLL" && e.file);
  const punches = plan.events.filter((e) => e.type === "PUNCH_IN");
  const hasCallouts = fs.existsSync(path.join(dir, "callouts.ass"));

  let chain = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[vbase]`;
  let current = "vbase";

  // punch-in: приближенная копия кадра поверх базы в заданных интервалах
  if (punches.length) {
    const splits = punches.map((_, i) => `[pz${i}]`).join("");
    chain += `;[${current}]split=${punches.length + 1}[vb0]${splits}`;
    current = "vb0";
    punches.forEach((p, i) => {
      const s = (p.scale ?? 1.06).toFixed(3);
      chain +=
        `;[pz${i}]crop=w=iw/${s}:h=ih/${s}:x=(iw-iw/${s})/2:y=(ih-ih/${s})/2,scale=1080:1920[pv${i}]` +
        `;[${current}][pv${i}]overlay=eof_action=pass:enable='between(t,${p.start.toFixed(2)},${p.end.toFixed(2)})'[vp${i}]`;
      current = `vp${i}`;
    });
  }

  // б-роллы поверх (голос не прерывается)
  brolls.forEach((b, k) => {
    const inputIdx = (music ? 2 : 1) + k;
    const clipDur = (b.end - b.start).toFixed(3);
    chain +=
      `;[${inputIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,` +
      `trim=duration=${clipDur},setpts=PTS-STARTPTS+${b.start.toFixed(3)}/TB[bv${k}]` +
      `;[${current}][bv${k}]overlay=eof_action=pass:enable='between(t,${b.start.toFixed(2)},${b.end.toFixed(2)})'[vo${k}]`;
    current = `vo${k}`;
  });

  chain += `;[${current}]ass=subs.ass${hasCallouts ? ",ass=callouts.ass" : ""}[v]`;

  const audioChain = music
    ? `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo];` +
      `[1:a]volume=0.22[mus];` +
      `[mus][vo]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];` +
      `[vo][duck]amix=inputs=2:duration=first:normalize=0[a]`
    : `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

  await runFfmpeg(
    [
      "-i", source,
      ...(music ? ["-stream_loop", "-1", "-i", MUSIC_FILE] : []),
      ...brolls.flatMap((b) => ["-i", b.file!]),
      "-filter_complex", `${chain};${audioChain}`,
      "-map", "[v]", "-map", "[a]",
      "-threads", "4",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      ...(music ? ["-shortest"] : []),
      "out.mp4",
    ],
    { cwd: dir, totalDurationSec: effDur, onProgress },
  );
}

/** Лёгкая проверка результата: файл существует, длительность/разрешение/звук в норме. */
async function selfCheck(dir: string, expectedDur: number): Promise<void> {
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
}

/** ASS-оверлей для обложки: крупный заголовок в верхней трети кадра. */
function buildCoverAss(title: string): string {
  const clean = title.replace(/[{}\\]/g, "").toUpperCase();
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Arial,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,10,3,8,70,70,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:30.00,Title,,0,0,0,,${clean}
`;
}
