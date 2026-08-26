import fs from "fs";
import path from "path";
import { getProject, updateProject, projectDir, hasMusic, MUSIC_FILE } from "./store";
import { probe, runFfmpeg, extractAudio, detectEdges } from "./ffmpeg";
import { scribeTranscribe, whisperTranscribe, alignScriptToDuration, Word } from "./transcribe";
import { buildAss } from "./subtitles";
import { generateMeta } from "./ai";
import { prepareBroll, BrollClip } from "./broll";

const running = new Set<string>();

function setStep(id: string, step: string, progress: number) {
  updateProject(id, { processing: { state: "running", step, progress } });
}

/**
 * Полный автомонтаж: обрезка тишины по краям, 9:16 1080×1920, лёгкий кинематографичный зум,
 * «горящие» субтитры (Scribe → Whisper → раскладка сценария), нормализация звука,
 * фоновая музыка с приглушением под голос, метаданные и обложка с заголовком.
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

    // --- Обрезаем тишину в начале и в конце ---
    setStep(id, "Обрезка пауз по краям", 7);
    const { start, end } = await detectEdges(raw, dir, info.duration);
    const effDur = end - start;

    // --- Распознавание речи: Scribe → Whisper → раскладка сценария ---
    setStep(id, "Распознавание речи", 12);
    const wav = path.join(dir, "audio.wav");
    await extractAudio(raw, "audio.wav", dir, { start, duration: effDur });

    let words: Word[] | null = null;
    let source: "scribe" | "whisper" | "script" = "script";
    try {
      words = await scribeTranscribe(wav);
      if (words) source = "scribe";
    } catch (e) {
      console.warn("Scribe недоступен:", e);
    }
    if (!words) {
      try {
        words = await whisperTranscribe(wav);
        if (words) source = "whisper";
      } catch (e) {
        console.warn("Whisper недоступен:", e);
      }
    }
    if (!words) {
      if (!project.script) throw new Error("Нет ни распознавания речи, ни сценария для субтитров");
      words = alignScriptToDuration(project.script, effDur);
    }

    setStep(id, "Генерация субтитров", 20);
    fs.writeFileSync(path.join(dir, "subs.ass"), buildAss(words), "utf8");

    // --- Б-роллы: перебивки поверх стримера на визуализируемых фразах ---
    setStep(id, "Подбор перебивок (б-ролл)", 22);
    let broll: BrollClip[] = [];
    try {
      broll = await prepareBroll(dir, words, project.topic);
    } catch (e) {
      console.warn("Б-роллы пропущены:", e);
    }

    // --- Метаданные (нужны до обложки — на ней заголовок) ---
    setStep(id, "Описание и хэштеги", 24);
    let meta = getProject(id)?.meta ?? null;
    if (!meta) {
      try {
        meta = (await generateMeta(project.topic, project.script ?? "")).meta;
      } catch (e) {
        console.warn("Метаданные не сгенерировались:", e);
        meta = { title: project.topic, description: "", hashtags: [] };
      }
    }

    // --- Монтаж ---
    setStep(id, "Монтаж видео", 28);
    const music = hasMusic();
    const totalFrames = Math.max(1, Math.round(effDur * 30));

    const buildVideoChain = (withZoom: boolean): string => {
      // базовая картинка стримера (зум опционален — на слабых серверах он съедает память)
      let chain =
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30` +
        (withZoom
          ? `,zoompan=z=1+0.07*in/${totalFrames}:d=1:x=(iw-iw/zoom)/2:y=(ih-ih/zoom)/2:s=1080x1920:fps=30`
          : "") +
        `[v0]`;
      // перебивки поверх (голос стримера продолжает идти)
      broll.forEach((clip, k) => {
        const inputIdx = (music ? 2 : 1) + k;
        const clipDur = (clip.end - clip.start).toFixed(3);
        chain +=
          `;[${inputIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,` +
          `trim=duration=${clipDur},setpts=PTS-STARTPTS+${clip.start.toFixed(3)}/TB[bv${k}]` +
          `;[v${k}][bv${k}]overlay=eof_action=pass:enable='between(t,${clip.start.toFixed(3)},${clip.end.toFixed(3)})'[v${k + 1}]`;
      });
      // субтитры поверх всего
      chain += `;[v${broll.length}]ass=subs.ass[v]`;
      return chain;
    };

    const audioChain = music
      ? `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[vo];` +
        `[1:a]volume=0.22[mus];` +
        `[mus][vo]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=500[duck];` +
        `[vo][duck]amix=inputs=2:duration=first:normalize=0[a]`
      : `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

    const encode = (withZoom: boolean) =>
      runFfmpeg(
        [
          "-ss", String(start), "-t", String(effDur), "-i", raw,
          ...(music ? ["-stream_loop", "-1", "-i", MUSIC_FILE] : []),
          ...broll.flatMap((clip) => ["-i", clip.file]),
          "-filter_complex", `${buildVideoChain(withZoom)};${audioChain}`,
          "-map", "[v]", "-map", "[a]",
          "-threads", "4",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          ...(music ? ["-shortest"] : []),
          "out.mp4",
        ],
        {
          cwd: dir,
          totalDurationSec: effDur,
          onProgress: (f) => setStep(id, "Монтаж видео", 28 + Math.round(f * 60)),
        },
      );

    try {
      await encode(true);
    } catch (e: any) {
      // сервер убил процесс по памяти — повторяем без зума (легче)
      if (String(e?.message ?? "").includes("остановлен системой")) {
        setStep(id, "Монтаж видео (экономный режим)", 30);
        await encode(false);
      } else throw e;
    }

    // --- Обложка: кадр из видео + крупный заголовок ---
    setStep(id, "Обложка", 92);
    const coverOffset = Math.min(Math.max(1, effDur * 0.25), Math.max(0.1, effDur - 0.2));
    let cover: string | null = null;
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

    updateProject(id, {
      processedVideo: "out.mp4",
      subtitlesSource: source,
      cover,
      coverOffsetSec: coverOffset,
      brollCount: broll.length,
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
