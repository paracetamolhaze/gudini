import React from "react";
import { AbsoluteFill, Img, interpolate } from "remotion";
import { theme } from "../theme";
import { useAsset } from "./assets";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { useInput, type AstraInput } from "../input";
import { EASE_IN, EASE_OUT, glide, leave } from "./motion";
import { Clip, useClip } from "./time";

type Pos = "lower" | "full";
type Props = {
  from: number;
  to: number;
  /** Asset name or path of a photo or picture. */
  src: string;
  /** full: the picture takes the screen, whole and uncropped; lower: a card over the lower part of the shot. */
  pos?: Pos;
  caption?: string;
  /** Slight tilt of a card in degrees. */
  tilt?: number;
  /** Kept for old montages; a missing picture is simply not shown. */
  fallback?: string;
  sfx?: SfxRole | false;
};

// The part of the frame TikTok does not cover: below the top bar, above the description.
const SAFE = { top: 175, height: 1330 };
const CARD = { maxW: 960, maxH: 640, centerY: 1260 };

/** A picture is never cropped: it is shown whole, and the rest of the frame is its own blurred copy. */
const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ src, pos = "full", caption, tilt = -1.5 }) => {
  const { frame, fps, lengthFrames } = useClip();
  const asset = useAsset();
  const { assets, sizes } = useInput();
  if (/^(photo|gen|scene):/.test(src) && !assets[src]) return null;
  const size = sizes[src];
  const aspect = size ? size.w / size.h : 0.8;
  const url = asset(src);
  const inP = glide(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.3);
  const drift = interpolate(frame, [0, lengthFrames], [1, 1.05]);

  if (pos === "full") {
    const fade = Math.min(interpolate(frame, [0, 0.22 * fps], [0, 1], { extrapolateRight: "clamp", easing: EASE_OUT }), out);
    // Tall pictures are composed for the phone screen: they fill it edge to edge, keeping their central 70%.
    if (aspect <= 0.85) {
      return (
        <AbsoluteFill style={{ opacity: fade, backgroundColor: theme.color.ink, overflow: "hidden" }}>
          <Img src={url} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", scale: String(drift * (1.05 - 0.05 * inP)) }} />
        </AbsoluteFill>
      );
    }
    // Wide pictures stay whole in the middle of the safe area over their own blur.
    const w = Math.min(1080, SAFE.height * aspect);
    const h = w / aspect;
    const top = SAFE.top + SAFE.height / 2 - h / 2;
    return (
      <AbsoluteFill style={{ opacity: fade, backgroundColor: theme.color.ink, overflow: "hidden" }}>
        <Img src={url} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", scale: "1.25", filter: "blur(46px) brightness(0.5) saturate(1.2)" }} />
        <Img src={url} style={{
          position: "absolute", left: (1080 - w) / 2, top, width: w, height: h, objectFit: "contain",
          scale: String(drift * (1.05 - 0.05 * inP)), borderRadius: w < 1070 ? 28 : 0,
          boxShadow: w < 1070 ? "0 30px 80px rgba(0,0,0,0.55)" : "none",
        }} />
      </AbsoluteFill>
    );
  }

  // A card sized to the picture's own shape, so nothing is cut or letterboxed.
  const w = Math.min(CARD.maxW, CARD.maxH * aspect);
  const h = w / aspect;
  const box = { x: (1080 - w) / 2, y: CARD.centerY - h / 2, w, h };
  const exitDrop = interpolate(frame, [lengthFrames - 0.3 * fps, lengthFrames], [0, 80], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: theme.radius, overflow: "hidden",
        boxShadow: `${theme.shadow}, 0 0 0 5px rgba(255,255,255,0.92)`, backgroundColor: theme.color.ink,
        opacity: Math.min(1, inP * 1.4) * out, scale: String(0.88 + 0.12 * inP), rotate: `${tilt * inP}deg`,
        translate: `0 ${(1 - inP) * 140 + exitDrop}px`,
      }}>
        <Img src={url} style={{ width: "100%", height: "100%", objectFit: "cover", scale: String(drift) }} />
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

/** A photo or picture of what is being talked about: whole on the screen, or as a card over the lower part. */
export const ImageCard: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Image ${rest.caption ?? rest.src}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback={rest.pos === "lower" ? "swipe" : "whoosh"} />
  </>
);
ImageCard.layoutOf = ({ from, to, pos = "full", src }, input) =>
  // A picture that was not found takes no space: nothing moves for it.
  /^(photo|gen|scene):/.test(src) && input && !input.assets[src] ? {}
  : pos === "full" ? { occupied: { from, to, zone: "full" } }
  : { occupied: { from, to, zone: "bottom" } };
