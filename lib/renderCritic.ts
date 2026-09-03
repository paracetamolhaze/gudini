import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpeg";
import { mediaVision, parseJson } from "./mediaLlm";
import { detectImageMediaType } from "./coverQc";
import { EditPlan } from "./editPlan";

/**
 * Критик готового ролика.
 *
 * Техническая самопроверка отвечает на вопрос «файл корректен»: длительность,
 * разрешение, звук, отсутствие чёрных кадров. Она не отвечает на вопрос
 * «на это можно смотреть». Ролик может быть технически безупречным и при этом
 * состоять из двадцати четырёх секунд одного лица подряд, а чужая финальная
 * карточка с «SUBSCRIBE» — оказаться прямо в кадре.
 *
 * Поэтому готовый файл раскладывается в раскадровку и показывается модели
 * ЦЕЛИКОМ, одним запросом. Мы смотрим на результат, а не на намерение.
 */

export type CriticIssueType =
  | "MOVING_CARD"
  | "EMPTY_CARD"
  | "WRONG_CARD_SIZE"
  | "FULLSCREEN_BROLL"
  | "AUTHOR_COVERED"
  | "INSET_OUT_OF_SAFE_AREA"
  | "STRETCHED_IMAGE"
  | "CAPTION_OVERLAP"
  | "ONE_WORD_CAPTIONS"
  | "LONG_AROLL_GAP"
  | "BROLL_CLUSTERING"
  | "SUBSCRIBE_OR_OUTRO"
  | "LARGE_TEXT"
  | "REPEATED_SCENE"
  | "IRRELEVANT_VISUAL"
  | "MISSING_PLANNED_VISUAL"
  | "ABRUPT_CHANGE";

export type CriticIssue = {
  start: number;
  end: number;
  type: CriticIssueType;
  reason: string;
};

export type CriticResult = {
  pass: boolean;
  score: number;
  issues: CriticIssue[];
  frames: number;
  sheet: string;
};

const CRITIC_SYSTEM = `You are reviewing a FINISHED vertical short-form video (TikTok/Reels).
You are given contact sheets: frames sampled from the final render, each labelled with its timecode in seconds.
You also get the planned timeline and the spoken transcript.

The intended style: the presenter fills the frame and stays visible the whole time.
After a short intro (the first ~3 seconds, presenter only, with a subtle zoom-in), a
STILL IMAGE CARD sits in the top part of the frame: always the same 900x506 box at
x=90, y=120. From the first card until the very end, some card is ALWAYS present;
cards replace each other with hard cuts. No video inserts, no card animation.
Captions are short phrases, white, 1-3 lines, in the lower third.

Judge the ACTUAL RESULT, not the intention. Report problems a viewer would notice:

- FULLSCREEN_BROLL: external footage fills the whole frame instead of sitting in the card.
- MOVING_CARD: the card shows moving video instead of a still image.
- EMPTY_CARD: after the intro, the top card area is empty (presenter only).
- WRONG_CARD_SIZE: the card is narrower or taller than the standard box, or in a different place.
- AUTHOR_COVERED: the presenter's face is hidden behind an insert.
- INSET_OUT_OF_SAFE_AREA: the insert sits too low, off-centre, or overlaps the bottom half.
- STRETCHED_IMAGE: the insert is squashed or stretched, aspect ratio broken.
- CAPTION_OVERLAP: an insert covers the subtitles.
- ONE_WORD_CAPTIONS: captions show a single word at a time, or jump between lines.
- LONG_AROLL_GAP: a long stretch where only the presenter's face is on screen. Anything above ~8 seconds is a problem.
- BROLL_CLUSTERING: all the external footage bunched into one part of the video while the rest has none.
- SUBSCRIBE_OR_OUTRO: someone else's end card, SUBSCRIBE/LIKE/THANKS FOR WATCHING, channel branding.
- LARGE_TEXT: big burned-in text, news chyrons, annotation labels over the footage. Stadium signage and jerseys are fine.
- REPEATED_SCENE: consecutive inserts showing essentially the same shot or the same place.
- IRRELEVANT_VISUAL: footage that does not match what is being said at that moment.
- MISSING_PLANNED_VISUAL: the plan says an insert is on screen, but the frames show the presenter.
- ABRUPT_CHANGE: a visually jarring cut.

Timecodes must come from the frame labels. Give start and end of each problem.
score: 0-100, how good this is as a short-form video.
pass: true only if there is no problem serious enough to publish with.

Reply with STRICT JSON only:
{"pass":false,"score":45,"issues":[{"start":0,"end":23.8,"type":"LONG_AROLL_GAP","reason":"..."}]}`;

/** Снимает кадры готового ролика: раз в секунду плюс отдельно вокруг монтажных границ. */
async function sampleFrames(dir: string, file: string, duration: number, cuts: number[]): Promise<{ at: number; path: string }[]> {
  const tmp = path.join(dir, "_critic");
  fs.mkdirSync(tmp, { recursive: true });
  const times = new Set<number>();
  for (let t = 0.5; t < duration; t += 1) times.add(Number(t.toFixed(2)));
  // границы вставок видно только вблизи них
  for (const c of cuts) {
    for (const d of [-0.25, 0.25]) {
      const t = c + d;
      if (t > 0.2 && t < duration - 0.2) times.add(Number(t.toFixed(2)));
    }
  }
  const out: { at: number; path: string }[] = [];
  for (const at of [...times].sort((a, b) => a - b)) {
    const f = path.join(tmp, `f-${at.toFixed(2)}.jpg`);
    try {
      await runFfmpeg(["-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=216:384", "-q:v", "6", f], { cwd: dir });
      if (fs.existsSync(f) && fs.statSync(f).size > 0) out.push({ at, path: f });
    } catch {}
  }
  return out;
}

/** Складывает кадры в подписанные листы: один лист — один запрос со зрением. */
async function buildSheets(dir: string, frames: { at: number; path: string }[]): Promise<string[]> {
  const tmp = path.join(dir, "_critic");
  const PER_SHEET = 24;
  const COLS = 6;
  const sheets: string[] = [];

  for (let s = 0; s * PER_SHEET < frames.length; s++) {
    const chunk = frames.slice(s * PER_SHEET, s * PER_SHEET + PER_SHEET);
    const tiles: string[] = [];
    for (const [i, fr] of chunk.entries()) {
      const tile = path.join(tmp, `t-${s}-${String(i).padStart(2, "0")}.jpg`);
      await runFfmpeg(
        [
          "-i", fr.path,
          "-vf",
          `drawbox=y=ih-26:w=iw:h=26:color=black@0.8:t=fill,` +
            `drawtext=text='${fr.at.toFixed(1)}s':fontcolor=white:fontsize=18:x=6:y=h-22`,
          "-q:v", "5", tile,
        ],
        { cwd: dir },
      );
      tiles.push(tile);
    }
    // Ряды должны быть одной ширины, иначе вертикальная склейка отказывает.
    // Неполный последний ряд дополняется пустыми плитками.
    const blank = path.join(tmp, "blank.jpg");
    if (!fs.existsSync(blank)) {
      await runFfmpeg(["-f", "lavfi", "-i", "color=c=#111111:s=216x384", "-frames:v", "1", "-q:v", "6", blank]);
    }
    const rows: string[] = [];
    for (let r = 0; r * COLS < tiles.length; r++) {
      const slice = tiles.slice(r * COLS, r * COLS + COLS);
      while (slice.length < COLS) slice.push(blank);
      const rowFile = path.join(tmp, `row-${s}-${r}.jpg`);
      await runFfmpeg([...slice.flatMap((t) => ["-i", t]), "-filter_complex", `hstack=inputs=${COLS}`, "-q:v", "4", rowFile]);
      rows.push(rowFile);
    }
    const sheet = path.join(tmp, `sheet-${s}.jpg`);
    if (rows.length === 1) fs.copyFileSync(rows[0], sheet);
    else await runFfmpeg([...rows.flatMap((t) => ["-i", t]), "-filter_complex", `vstack=inputs=${rows.length}`, "-q:v", "4", sheet]);
    sheets.push(sheet);
  }
  return sheets;
}

/**
 * Один платный вызов на ролик. Возвращает найденные проблемы; решение о том,
 * публиковать ли, принимает вызывающий — критик не запускает пересборку сам.
 */
export async function criticiseRender(args: {
  dir: string;
  file: string;
  duration: number;
  plan: EditPlan;
  transcript: string;
  keepSheets?: boolean;
}): Promise<CriticResult> {
  const { dir, file, duration, plan, transcript } = args;
  const inserts = plan.events.filter((e) => e.type === "B_ROLL" && e.file);
  const cuts = inserts.flatMap((e) => [e.start, e.end]);

  const frames = await sampleFrames(dir, file, duration, cuts);
  if (!frames.length) throw new Error("Критик: не удалось снять ни одного кадра готового ролика");
  const sheets = await buildSheets(dir, frames);

  const timeline = inserts
    .map((e) => `${e.start.toFixed(1)}–${e.end.toFixed(1)}s: ${path.basename(e.file!)}`)
    .join("\n");

  const raw = await mediaVision({
    system: CRITIC_SYSTEM,
    stage: "Creative Director",
    maxTokens: 3000,
    images: sheets.map((s) => {
      const buf = fs.readFileSync(s);
      return { base64: buf.toString("base64"), mediaType: detectImageMediaType(buf) };
    }),
    user:
      `Video duration: ${duration.toFixed(1)}s. Frames are labelled with their timecode.\n\n` +
      `Planned inserts:\n${timeline || "(none)"}\n\n` +
      `Transcript:\n${transcript.slice(0, 2000)}`,
  });

  const json = parseJson<any>(raw, "Критик ролика");
  const issues: CriticIssue[] = (Array.isArray(json.issues) ? json.issues : []).map((i: any) => ({
    start: Number(i.start) || 0,
    end: Number(i.end) || 0,
    type: String(i.type ?? "ABRUPT_CHANGE") as CriticIssueType,
    reason: String(i.reason ?? "").slice(0, 220),
  }));

  if (!args.keepSheets) {
    try {
      fs.rmSync(path.join(dir, "_critic"), { recursive: true, force: true });
    } catch {}
  }

  return {
    pass: json.pass === true && issues.length === 0,
    score: Number(json.score) || 0,
    issues,
    frames: frames.length,
    sheet: sheets[0] ?? "",
  };
}
