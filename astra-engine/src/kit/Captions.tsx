import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, useVideoConfig } from "remotion";
import { useInput, type Word } from "../input";
import { theme } from "../theme";
import { useOccupied, zonesAt } from "./layout";
import { EASE_OUT } from "./motion";
import { useAbsoluteFrame } from "./time";

export type CaptionPos = "low" | "mid" | "high" | "above-panel" | { x?: number; y: number };
export type CaptionStyle = "clean" | "bold" | "minimal";

// above-panel: between the raised author's chin and the top edge of a bottom panel.
const POS_Y = { low: 1330, mid: 1010, high: 330, "above-panel": 900 } as const;
const CENTER_X = 505;

const STYLES: Record<CaptionStyle, { font: React.CSSProperties; emphasis: string }> = {
  clean: {
    font: { fontFamily: theme.font.text, fontWeight: 800, fontSize: 66, letterSpacing: -0.5 },
    emphasis: theme.color.highlight,
  },
  bold: {
    font: { fontFamily: theme.font.text, fontWeight: 900, fontSize: 72, textTransform: "uppercase", letterSpacing: 0 },
    emphasis: theme.color.highlight,
  },
  minimal: {
    font: { fontFamily: theme.font.text, fontWeight: 600, fontSize: 62, textTransform: "lowercase", letterSpacing: -0.5 },
    emphasis: theme.color.accent,
  },
};

const OUTLINE = [
  "0 0 2px rgba(0,0,0,0.9)", "2px 2px 0 rgba(0,0,0,0.45)", "-2px 2px 0 rgba(0,0,0,0.45)",
  "2px -2px 0 rgba(0,0,0,0.45)", "-2px -2px 0 rgba(0,0,0,0.45)", "0 8px 28px rgba(0,0,0,0.6)",
].join(", ");

/** Splits speech into short readable groups: at pauses, sentence ends, or after 3 words. */
export function groupWords(words: Word[], maxWords = 3, maxChars = 20): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  words.forEach((word, index) => {
    const prev = words[index - 1];
    const gap = prev ? word.start - prev.end : 0;
    const sentenceEnd = prev ? /[.!?…]["»”)]?$/.test(prev.word) : false;
    const clauseEnd = prev ? /[,;:—–]$/.test(prev.word) : false;
    if (current.length && (gap > 0.35 || sentenceEnd || current.length >= maxWords || chars + word.word.length > maxChars || (clauseEnd && current.length >= 2))) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += word.word.length + 1;
  });
  if (current.length) groups.push(current);
  return groups;
}

type Props = {
  style?: CaptionStyle;
  /** Word indices shown bigger and in the accent color: the words the viewer must catch. */
  emphasis?: number[];
  /** Where captions stand during given intervals; elsewhere they sit low, or high when a bottom panel is open. */
  placements?: { from: number; to: number; pos: CaptionPos }[];
  /** Intervals without captions, e.g. when a card already shows the same words. */
  hidden?: { from: number; to: number }[];
  maxWords?: number;
};

/** Word-by-word captions: each word appears when it is spoken, the group stays readable. */
export const Captions: React.FC<Props> = ({ style = "clean", emphasis = [], placements = [], hidden = [], maxWords = 3 }) => {
  const { words } = useInput();
  const { fps } = useVideoConfig();
  const frame = useAbsoluteFrame();
  const occupied = useOccupied();
  const t = frame / fps;
  const groups = useMemo(() => groupWords(words, maxWords), [words, maxWords]);
  const look = STYLES[style];
  const emphasized = new Set(emphasis);

  const index = groups.findIndex((g, i) => {
    const start = words[g[0]].start - 0.08;
    const nextStart = groups[i + 1] ? words[groups[i + 1][0]].start - 0.02 : Infinity;
    const end = Math.min(nextStart, words[g[g.length - 1]].end + 0.6);
    return t >= start && t < end;
  });
  if (index < 0) return null;
  const group = groups[index];
  const groupStart = words[group[0]].start;
  if (hidden.some(h => groupStart >= h.from && groupStart < h.to)) return null;

  const zones = zonesAt(occupied, groupStart);
  const placed = placements.find(p => groupStart >= p.from && groupStart < p.to)?.pos;
  const pos: CaptionPos = placed ?? (zones.includes("bottom") ? "above-panel" : "low");
  const y = typeof pos === "string" ? POS_Y[pos] : pos.y;
  const x = typeof pos === "string" ? CENTER_X : pos.x ?? CENTER_X;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: x - 410, top: y, width: 820, translate: "0 -50%",
        display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "baseline",
        columnGap: 18, rowGap: 4, lineHeight: 1.12, textAlign: "center", color: theme.color.text,
        ...look.font,
      }}>
        {group.map(i => {
          const word = words[i];
          const appear = interpolate(t, [word.start - 0.06, word.start + 0.14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
          const strong = emphasized.has(i);
          return (
            <span key={i} style={{
              display: "inline-block",
              // Emphasis grows the font itself, so the layout keeps the gap between words.
              fontSize: strong ? "1.14em" : "1em",
              opacity: appear,
              translate: `0 ${(1 - appear) * 22}px`,
              scale: String(0.9 + 0.1 * appear),
              filter: `blur(${(1 - appear) * 8}px)`,
              color: strong ? look.emphasis : theme.color.text,
              textShadow: strong ? `${OUTLINE}, 0 0 26px ${look.emphasis}66` : OUTLINE,
            }}>
              {word.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
