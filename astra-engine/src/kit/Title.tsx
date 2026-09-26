import React from "react";
import { fitText, measureText } from "@remotion/layout-utils";
import { AbsoluteFill, interpolate } from "remotion";
import { faceOf, useInput } from "../input";
import { color, theme } from "../theme";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { useHighestTop } from "./camera";
import { EASE_OUT, leave } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** Punchy line of 2–6 words; words rise one after another. */
  text: string;
  /** Top edge of the title block; by default just under the TikTok top bar, above the head. */
  top?: number;
  /** Height the title may take; the font shrinks to fit. */
  maxHeight?: number;
  color?: string;
  /** Solid accent block behind the text, like a sticker. */
  box?: boolean;
  sfx?: SfxRole | false;
};

const WIDTH = 840;

/** Largest size at which the words wrap into lines that fit the box. */
function layout(words: string[], maxHeight: number) {
  const font = { fontFamily: theme.font.display, fontWeight: "700" as const };
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
  let size = Math.min(170, fitText({ text: longest, withinWidth: WIDTH, ...font }).fontSize);
  for (; size > 56; size -= 4) {
    const space = size * 0.22;
    let lines = 1, line = 0;
    for (const word of words) {
      const w = measureText({ text: word, fontSize: size, ...font }).width;
      if (line > 0 && line + space + w > WIDTH) { lines++; line = w; } else line += (line > 0 ? space : 0) + w;
    }
    if (lines * size * 1.08 <= maxHeight) return size;
  }
  return size;
}

const Body: React.FC<Omit<Props, "sfx">> = ({ from, to, text, top = theme.safe.top + 30, maxHeight = 230, color: tint, box = false }) => {
  const { frame, fps, lengthFrames } = useClip();
  const input = useInput();
  const highestTop = useHighestTop();
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  // The block ends above the head wherever the camera puts it during the title.
  const room = highestTop(faceOf(input), from, to) - 28 - top - (box ? 28 : 0);
  const size = layout(words, Math.max(90, Math.min(maxHeight, room)));
  const out = leave(frame, fps, lengthFrames, 0.25);
  const boxIn = interpolate(frame, [0, 0.35 * fps], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: out }}>
      <div style={{ position: "absolute", left: (1080 - WIDTH) / 2 - 20, width: WIDTH + 40, top, display: "flex", justifyContent: "center" }}>
        <div style={{
          display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: size * 0.22, padding: box ? "14px 30px" : 0,
          backgroundColor: box ? theme.color.accent : "transparent", borderRadius: 22,
          clipPath: box ? `inset(0 ${100 - boxIn}% 0 0 round 22px)` : undefined,
        }}>
          {words.map((word, i) => {
            const p = interpolate(frame, [(0.08 + i * 0.07) * fps, (0.45 + i * 0.07) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
            return (
              <span key={i} style={{ display: "inline-block", overflow: "hidden", lineHeight: 1.04, paddingBottom: 4 }}>
                <span style={{
                  display: "inline-block", translate: `0 ${(1 - p) * 105}%`,
                  fontFamily: theme.font.display, fontWeight: 700, fontSize: size,
                  color: box ? theme.color.ink : color(tint, "text"),
                  textShadow: box ? "none" : "0 8px 30px rgba(0,0,0,0.55)",
                }}>
                  {word}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Big kinetic title in front of the author: hooks, section names, punchlines. Sits above the head. */
export const Title: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Title ${rest.text}`}><Body from={from} to={to} {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" volume={0.45} />
  </>
);
Title.layoutOf = ({ from, to, text }) => ({ occupied: { from, to, zone: "top", text } });
