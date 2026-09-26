import React from "react";
import { evolvePath } from "@remotion/paths";
import { AbsoluteFill, interpolate } from "remotion";
import { color, theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import { EASE_OUT, enter, leave } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** Where the label stands (arrow tail). */
  x1: number;
  y1: number;
  /** What the arrow points at. */
  x2: number;
  y2: number;
  /** Handwritten note, a few words. */
  label?: string;
  /** Curvature: positive bends one way, negative the other. */
  bend?: number;
  color?: string;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ x1, y1, x2, y2, label, bend = 0.3, color: tint }) => {
  const { frame, fps, lengthFrames } = useClip();
  const dx = x2 - x1, dy = y2 - y1;
  const cx = (x1 + x2) / 2 - dy * bend, cy = (y1 + y2) / 2 + dx * bend;
  const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  const draw = interpolate(frame, [0.12 * fps, 0.6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  const { strokeDasharray, strokeDashoffset } = evolvePath(draw, path);
  const angle = Math.atan2(y2 - cy, x2 - cx);
  const head = 34;
  const tip = (a: number) => `${x2 - head * Math.cos(angle + a)},${y2 - head * Math.sin(angle + a)}`;
  const headIn = interpolate(draw, [0.85, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const out = leave(frame, fps, lengthFrames, 0.25);
  const labelIn = enter(frame, fps, 0.3);
  const stroke = color(tint, "text");
  return (
    <AbsoluteFill style={{ opacity: out, pointerEvents: "none" }}>
      <svg width={1080} height={1920} style={{ position: "absolute", overflow: "visible", filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.5))" }}>
        <path d={path} fill="none" stroke={stroke} strokeWidth={7} strokeLinecap="round" strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
        <polyline points={`${tip(0.5)} ${x2},${y2} ${tip(-0.5)}`} fill="none" stroke={stroke} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" opacity={headIn} />
      </svg>
      {label ? (
        <div style={{
          position: "absolute", left: x1 - 260, top: y1 - 92, width: 520, textAlign: "center",
          fontFamily: theme.font.hand, fontWeight: 700, fontSize: 66, lineHeight: 1, color: stroke,
          textShadow: "0 4px 14px rgba(0,0,0,0.6)", opacity: labelIn, scale: String(0.85 + 0.15 * labelIn),
        }}>
          {label}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** Hand-drawn arrow with a note, pointing at something in the frame. */
export const Arrow: React.FC<Props> = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Arrow ${rest.label ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="swipe" volume={0.35} />
  </>
);
