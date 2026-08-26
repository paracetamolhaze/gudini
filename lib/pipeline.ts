import fs from "fs";
import path from "path";
import { getProject, updateProject, projectDir } from "./store";
import { probe, runFfmpeg, extractAudio } from "./ffmpeg";
import { whisperTranscribe, alignScriptToDuration, Word } from "./transcribe";
import { buildAss } from "./subtitles";
import { generateMeta } from "./ai";

const running = new Set<string>();

function setStep(id: string, step: string, progress: number) {
  updateProject(id, { processing: { state: "running", step, progress } });
}

/** Полный автомонтаж: 9:16, нормализация звука, «горящие» субтитры, метаданные. */
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

    // --- Субтитры: Whisper по речи или раскладка сценария по времени ---
    setStep(id, "Распознавание речи", 8);
    let words: Word[] | null = null;
    let source: "whisper" | "script" = "script";
    try {
      const wav = path.join(dir, "audio.wav");
      await extractAudio(raw, "audio.wav", dir);
      words = await whisperTranscribe(wav);
      if (words) source = "whisper";
    } catch (e) {
      console.warn("Whisper недоступен, используем сценарий:", e);
    }
    if (!words) {
      if (!project.script) throw new Error("Нет ни распознавания речи, ни сценария для субтитров");
      words = alignScriptToDuration(project.script, info.duration);
    }

    setStep(id, "Генерация субтитров", 20);
    fs.writeFileSync(path.join(dir, "subs.ass"), buildAss(words), "utf8");

    // --- Монтаж: кадрирование 9:16 1080x1920, субтитры, нормализация громкости ---
    setStep(id, "Монтаж видео", 25);
    const filters = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      "fps=30",
      "ass=subs.ass",
    ].join(",");
    await runFfmpeg(
      [
        "-i", raw,
        "-vf", filters,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "out.mp4",
      ],
      {
        cwd: dir,
        totalDurationSec: info.duration,
        onProgress: (f) => setStep(id, "Монтаж видео", 25 + Math.round(f * 60)),
      },
    );

    // --- Метаданные для публикации ---
    setStep(id, "Описание и хэштеги", 90);
    const current = getProject(id);
    let meta = current?.meta ?? null;
    if (!meta) {
      const generated = await generateMeta(project.topic, project.script ?? "");
      meta = generated.meta;
    }

    updateProject(id, {
      processedVideo: "out.mp4",
      subtitlesSource: source,
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
