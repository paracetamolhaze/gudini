import type { AstraInput } from "../src/input";
import { loadExamples, loadGuide } from "./knowledge";

export type Task = {
  topic: string;
  input: AstraInput;
  /** Owner's feedback on earlier videos, newest last. */
  lessons: string[];
  /** Meme clips available in the owner's library, by name. */
  memes?: string[];
  /** Checked facts of the story. */
  facts?: string[];
};

const OUTPUT = `## Ответ

Ответ — полный текст файла Montage.tsx и больше ничего: без markdown-ограждений и без пояснений. Файл начинается с import и экспортирует Montage.`;

/** System prompt: how Astra edits, the kit, and worked examples. */
export function systemPrompt(): string {
  const guide = loadGuide();
  const examples = loadExamples().map(e => e.text).join("\n\n---\n\n");
  return [guide.director, guide.kit, "# Образцы монтажа\n\n" + examples, OUTPUT].join("\n\n---\n\n");
}

function transcript(input: AstraInput): string {
  return input.words.map((w, i) => `${i}:${w.word}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(" ");
}

/** The concrete video: its speech with timings, the frame, and what the libraries hold. */
export function taskPrompt(task: Task): string {
  const { input } = task;
  const sounds = Object.entries(input.sounds).filter(([, files]) => files.length).map(([role]) => role);
  const music = Object.entries(input.music).filter(([, files]) => files.length).map(([mood]) => mood);
  const face = input.face;
  return [
    `# Ролик`,
    `Тема: ${task.topic}`,
    `Длительность: ${input.duration.toFixed(2)} с. Кадр 1080×1920.`,
    face ? `Голова автора в обычном кадре: x ${face.x}–${face.x + face.w}, y ${face.y}–${face.y + face.h}.` : "",
    `Звуки в библиотеке: ${sounds.length ? sounds.join(", ") : "пока пусто (встроенные звуки кубиков прозвучат, когда библиотеку наполнят)"}.`,
    `Музыка в библиотеке: ${music.length ? music.join(", ") : "пока пусто — всё равно выбери настроение, оно зазвучит, когда треки появятся"}.`,
    `Картинки: настоящие фото (<Photo query="..." look="...">), логотипы (<Logo name="...">), реалистичные сцены (<Scene prompt="...">) и превращения автора (<Morph into="...">) готовятся по твоему запросу перед рендером.` +
      ` Мемы в библиотеке: ${task.memes?.length ? task.memes.join(", ") : "пока нет"}.` +
      (Object.keys(input.assets).length ? ` Готовые материалы автора: ${Object.keys(input.assets).join(", ")}.` : ""),
    ``,
    task.facts?.length ? `## Факты истории\nПо ним строятся сцены и фото: кто участвует, что у них в руках, где это было.\n${task.facts.map(f => `- ${f}`).join("\n")}\n` : "",
    `## Расшифровка`,
    `индекс:слово@начало-конец`,
    transcript(input),
    ``,
    `## Уроки`,
    task.lessons.length ? task.lessons.map(l => `- ${l}`).join("\n") : "Пока нет.",
    ``,
    `Смонтируй этот ролик.`,
  ].filter(line => line !== undefined).join("\n");
}

export function fixPrompt(task: Task, code: string, problems: string[]): string {
  return [
    taskPrompt(task),
    ``,
    `## Твой файл`,
    code,
    ``,
    `## Что мешает собрать ролик`,
    problems.map(p => `- ${p}`).join("\n"),
    ``,
    `Верни исправленный файл целиком, сохранив задуманный монтаж.`,
  ].join("\n");
}

export function reviewPrompt(task: Task, code: string, frames: { label: string }[], notes: string[]): string {
  return [
    taskPrompt(task),
    ``,
    `## Твой черновик`,
    code,
    ``,
    `## Как он выглядит`,
    `К заданию приложены кадры черновика в таком порядке:`,
    frames.map((f, i) => `${i + 1}. ${f.label}`).join("\n"),
    notes.length ? `\nЗамечания автоматической проверки:\n${notes.map(n => `- ${n}`).join("\n")}` : "",
    ``,
    `Посмотри на кадры глазами зрителя и сравни с образцом ритма. Что читается плохо, что закрывает лицо, где пусто или перегружено, где событие не совпадает со словом — поправь.`,
    `Верни улучшенный файл целиком. Если черновик уже хорош, верни его без изменений.`,
  ].join("\n");
}
