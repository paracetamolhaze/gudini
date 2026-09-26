import React from "react";
import { AbsoluteFill, Img, interpolate } from "remotion";
import { theme } from "../theme";
import { useAsset } from "./assets";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { useInput, type AstraInput } from "../input";
import { Icon } from "./List";
import { EASE_IN, glide, leave, pop } from "./motion";
import { Clip, useClip } from "./time";

type Pos = "lower" | "full" | { x: number; y: number; w: number; h: number };
type Props = {
  from: number;
  to: number;
  /** Asset name or path of a photo or screenshot. */
  src: string;
  /** lower: card under the face while the author moves up; full: cutaway over the whole frame. */
  pos?: Pos;
  caption?: string;
  /** Slight tilt in degrees; 0 for screenshots that must read straight. */
  tilt?: number;
  fit?: "cover" | "contain";
  /** Emoji shown instead when a requested photo was not found. */
  fallback?: string;
  sfx?: SfxRole | false;
};

// Over the lower part of the shot, below the face; captions move above the head meanwhile.
const LOWER = { x: 60, y: 1000, w: 960, h: 540 };

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ src, pos = "lower", caption, tilt = -1.5, fit = "cover", fallback }) => {
  const { frame, fps, lengthFrames } = useClip();
  const asset = useAsset();
  const { assets } = useInput();
  const inP = glide(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.3);
  const zoom = interpolate(frame, [0, lengthFrames], [1, 1.08]);
  // A photo that was not found turns into its fallback emoji instead of breaking the render.
  if (/^(photo|gen):/.test(src) && !assets[src]) {
    if (!fallback) return null;
    const s = pop(frame, fps);
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{ position: "absolute", left: 830 - 120, top: 560 - 120, scale: String(s * (0.6 + 0.4 * out)), opacity: out }}>
          <Icon icon={fallback} size={240} />
        </div>
      </AbsoluteFill>
    );
  }
  if (pos === "full") {
    const fade = Math.min(interpolate(frame, [0, 0.25 * fps], [0, 1], { extrapolateRight: "clamp" }), out);
    return (
      <AbsoluteFill style={{ opacity: fade, backgroundColor: theme.color.ink }}>
        <Img src={asset(src)} style={{ width: "100%", height: "100%", objectFit: fit, scale: String(zoom * (1.06 - 0.06 * inP)) }} />
      </AbsoluteFill>
    );
  }
  const box = pos === "lower" ? LOWER : pos;
  const exitDrop = interpolate(frame, [lengthFrames - 0.3 * fps, lengthFrames], [0, 80], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: theme.radius, overflow: "hidden",
        boxShadow: `${theme.shadow}, 0 0 0 5px rgba(255,255,255,0.92)`, backgroundColor: theme.color.ink,
        opacity: Math.min(1, inP * 1.4) * out, scale: String(0.88 + 0.12 * inP), rotate: `${tilt * inP}deg`,
        translate: `0 ${(1 - inP) * 140 + exitDrop}px`,
      }}>
        <Img src={asset(src)} style={{ width: "100%", height: "100%", objectFit: fit, scale: String(zoom) }} />
      </div>
      {caption ? (
        <div style={{ position: "absolute", left: box.x + 26, top: box.y - 34, opacity: inP * out, rotate: `${tilt}deg` }}>
          <span style={{ fontFamily: theme.font.text, fontWeight: 800, fontSize: 34, color: theme.color.ink, backgroundColor: theme.color.highlight, padding: "8px 18px", borderRadius: 12 }}>
            {caption}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** A photo or screenshot of what is being talked about: under the face, or as a full cutaway. */
export const ImageCard: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Image ${rest.caption ?? rest.src}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback={rest.pos === "full" ? "whoosh" : "swipe"} volume={0.45} />
  </>
);
ImageCard.layoutOf = ({ from, to, pos = "lower", src }, input) =>
  // A photo that was not found takes no space: nothing moves for it.
  /^(photo|gen):/.test(src) && input && !input.assets[src] ? {}
  : pos === "full" ? { occupied: { from, to, zone: "full" } }
  : pos === "lower" ? { occupied: { from, to, zone: "bottom" } }
  : {};
