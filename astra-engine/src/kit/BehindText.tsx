import React from "react";
import { fitText } from "@remotion/layout-utils";
import { AbsoluteFill, interpolate, OffthreadVideo, staticFile } from "remotion";
import { faceOf, useInput } from "../input";
import { color, theme } from "../theme";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { CameraLayer } from "./camera";
import { EASE_OUT, leave } from "./motion";
import { Clip, useClip, useClipOffset } from "./time";

type Props = {
  from: number;
  to: number;
  /** One to three words, said right now. Written uppercase in the display font. */
  text: string;
  /** Vertical center of the text; by default at forehead level so the head covers part of it. */
  y?: number;
  color?: string;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "sfx">> = ({ from, to, text, y, color: tint }) => {
  const input = useInput();
  const face = faceOf(input);
  const { frame, fps, lengthFrames } = useClip();
  const offset = useClipOffset();
  const cutout = input.cutouts.find(c => c.from <= from + 0.05 && c.to >= to - 0.05);
  const upper = text.toUpperCase();
  const { fontSize } = fitText({ text: upper, withinWidth: 990, fontFamily: theme.font.display, fontWeight: "700" });
  const size = Math.max(120, Math.min(360, fontSize));
  // Without a cutout the text would cover the face, so it moves above the head instead.
  const center = cutout ? y ?? face.y + face.h * 0.3 : Math.min(y ?? Infinity, face.y - size * 0.45);
  const appear = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  const out = leave(frame, fps, lengthFrames, 0.3);
  return (
    <>
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{
          position: "absolute", left: 0, right: 0, top: center, translate: `0 ${-50 + (1 - appear) * 12}%`,
          textAlign: "center", whiteSpace: "nowrap",
          fontFamily: theme.font.display, fontWeight: 700, fontSize: size, lineHeight: 1, letterSpacing: (1 - appear) * 24,
          color: color(tint, "accent"),
          opacity: appear * out,
          filter: `blur(${(1 - appear) * 14 + (1 - out) * 10}px)`,
          textShadow: "0 10px 40px rgba(0,0,0,0.35)",
        }}>
          {upper}
        </div>
      </AbsoluteFill>
      {cutout ? (
        <CameraLayer>
          <OffthreadVideo src={staticFile(cutout.src)} transparent muted trimBefore={Math.max(0, offset - Math.round(cutout.from * fps))} style={{ width: "100%", height: "100%" }} />
        </CameraLayer>
      ) : null}
    </>
  );
};

/** Huge word behind the author: the head and shoulders cover part of it. Needs a cutout for its time range. */
export const BehindText: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Behind ${rest.text}`}><Body from={from} to={to} {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" volume={0.5} />
  </>
);
BehindText.layoutOf = ({ from, to, text }) => ({ occupied: { from, to, zone: "word", text } });
