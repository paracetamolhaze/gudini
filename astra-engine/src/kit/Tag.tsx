import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import { EASE_OUT, enter, leave } from "./motion";
import { Clip, useClip } from "./time";

type Tone = "accent" | "blue" | "dark";
const TONES: Record<Tone, React.CSSProperties> = {
  accent: { backgroundColor: theme.color.accent, color: theme.color.ink },
  blue: { backgroundColor: theme.color.accent2, color: theme.color.text },
  dark: { backgroundColor: "rgba(13,17,21,0.88)", color: theme.color.accent, boxShadow: `inset 0 0 0 3px ${theme.color.accent}` },
};

type Props = {
  from: number;
  to: number;
  /** Short label: a stage, a section, a category. Up to ~24 characters. */
  text: string;
  pos?: "top-left" | "top-center" | { x: number; y: number };
  tone?: Tone;
  sfx?: SfxRole | false;
};

const TagBody: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ text, pos = "top-left", tone = "blue" }) => {
  const { frame, fps, lengthFrames } = useClip();
  const inP = enter(frame, fps, 0.42);
  const outP = leave(frame, fps, lengthFrames, 0.25);
  const wipe = interpolate(frame, [0, 0.38 * fps], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  const at = pos === "top-left" ? { left: 60, top: 220 } : pos === "top-center" ? { left: 0, right: 0, top: 220 } : { left: pos.x, top: pos.y };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", ...at, display: "flex", justifyContent: pos === "top-center" ? "center" : "flex-start" }}>
        <div style={{
          ...TONES[tone],
          fontFamily: theme.font.text, fontWeight: 800, fontSize: 36, letterSpacing: 2, textTransform: "uppercase",
          padding: "14px 26px", borderRadius: 16, whiteSpace: "nowrap",
          opacity: inP * outP,
          translate: `${(1 - inP) * -36}px ${(1 - outP) * -14}px`,
          clipPath: `inset(0 ${100 - wipe}% 0 0 round 16px)`,
        }}>
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Small label chip in the corner, e.g. «ЭТАП 1» or «01 / ИНСТРУМЕНТЫ». */
export const Tag: React.FC<Props> = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Tag ${rest.text}`}><TagBody {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="click" volume={0.4} />
  </>
);
