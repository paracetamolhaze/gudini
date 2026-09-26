import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, spring, useVideoConfig } from "remotion";
import { useInput, type Word } from "../input";
import { theme } from "../theme";
import { useOccupied, zonesAt } from "./layout";
import { useAbsoluteFrame } from "./time";

export type CaptionPos = "low" | "mid" | "high" | "above-panel" | { y: number };
export type CaptionStyle = "clean" | "bold" | "minimal";

// above-panel: between the raised author's chin and the top edge of a bottom panel.
const POS_Y = { low: 1330, mid: 1010, high: 330, "above-panel": 880 } as const;

const STYLES: Record<CaptionStyle, { font: React.CSSProperties; emphasis: string }> = {
  clean: { font: { fontFamily: theme.font.text, fontWeight: 800, fontSize: 74, letterSpacing: -0.5 }, emphasis: theme.color.highlight },
  bold: { font: { fontFamily: theme.font.text, fontWeight: 900, fontSize: 80, textTransform: "uppercase" }, emphasis: theme.color.highlight },
  minimal: { font: { fontFamily: theme.font.text, fontWeight: 700, fontSize: 70, textTransform: "lowercase", letterSpacing: -0.5 }, emphasis: theme.color.accent },
};

const OUTLINE = [
  "0 0 3px rgba(0,0,0,0.9)", "3px 3px 0 rgba(0,0,0,0.4)", "-3px 3px 0 rgba(0,0,0,0.4)",
  "3px -3px 0 rgba(0,0,0,0.4)", "-3px -3px 0 rgba(0,0,0,0.4)", "0 10px 30px rgba(0,0,0,0.55)",
].join(", ");

/** The word as it is shown: punctuation around it goes away, inner hyphens stay (15-летних). */
export function captionText(word: string): string {
  return word.replace(/^[\s.,!?…:;"'«»„“”()\[\]—–-]+/, "").replace(/[\s.,!?…:;"'«»„“”()\[\]—–-]+$/, "");
}

const normalize = (text: string) => captionText(text).toLowerCase().replace(/ё/g, "е");

/** When each word is on screen: from the moment it is said until the next word, with a short hold in pauses. */
export function wordWindows(words: Word[]): { index: number; text: string; from: number; to: number }[] {
  const shown = words.map((w, index) => ({ index, text: captionText(w.word), w })).filter(x => x.text.length > 0);
  return shown.map((x, i) => {
    const next = shown[i + 1]?.w.start ?? Infinity;
    const hold = Math.min(next, Math.max(x.w.end + 0.35, x.w.start + 0.3));
    return { index: x.index, text: x.text, from: x.w.start - 0.03, to: next - x.w.end < 0.5 ? next - 0.01 : hold };
  });
}

type Props = {
  style?: CaptionStyle;
  /** Word indices shown in the accent color and bigger: the words the viewer must catch. */
  emphasis?: number[];
  /** Where captions stand during given intervals; elsewhere low, or above a bottom panel. */
  placements?: { from: number; to: number; pos: CaptionPos }[];
  /** Intervals without captions. */
  hidden?: { from: number; to: number }[];
};

/** One word at a time, centered, appearing exactly when it is said. */
export const Captions: React.FC<Props> = ({ style = "clean", emphasis = [], placements = [], hidden = [] }) => {
  const { words } = useInput();
  const { fps } = useVideoConfig();
  const frame = useAbsoluteFrame();
  const occupied = useOccupied();
  const t = frame / fps;
  const windows = useMemo(() => wordWindows(words), [words]);
  const current = windows.find(w => t >= w.from && t < w.to);
  if (!current) return null;
  if (hidden.some(h => current.from + 0.03 >= h.from && current.from + 0.03 < h.to)) return null;
  // A big word on screen already says this word: the caption steps aside instead of repeating it.
  const said = occupied.filter(o => o.text && t >= o.from && t < o.to).some(o => normalize(o.text!).split(/\s+/).includes(normalize(current.text)));
  if (said) return null;

  const look = STYLES[style];
  const strong = emphasis.includes(current.index);
  const zones = zonesAt(occupied, current.from);
  const placed = placements.find(p => current.from >= p.from && current.from < p.to)?.pos;
  const pos: CaptionPos = placed ?? (zones.includes("bottom") ? "above-panel" : "low");
  const y = typeof pos === "string" ? POS_Y[pos] : pos.y;
  const local = frame - Math.round(current.from * fps);
  const p = spring({ frame: local, fps, config: { damping: 14, stiffness: 260, mass: 0.5 } });
  const blur = interpolate(local, [0, 3], [6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 90, right: 90, top: y, translate: "0 -50%", display: "flex", justifyContent: "center" }}>
        <span style={{
          ...look.font,
          fontSize: (look.font.fontSize as number) * (strong ? 1.18 : 1),
          display: "inline-block", whiteSpace: "nowrap", lineHeight: 1.1,
          color: strong ? look.emphasis : theme.color.text,
          textShadow: strong ? `${OUTLINE}, 0 0 30px ${look.emphasis}77` : OUTLINE,
          scale: String(0.82 + 0.18 * p), filter: `blur(${blur}px)`, opacity: Math.min(1, p * 1.6),
        }}>
          {current.text}
        </span>
      </div>
    </AbsoluteFill>
  );
};
