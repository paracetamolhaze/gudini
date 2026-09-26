import React from "react";
import { AbsoluteFill, Img, interpolate } from "remotion";
import { useInput, type AstraInput } from "../input";
import { useAsset } from "./assets";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { CameraLayer } from "./camera";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** What the author turns into, in English: "a friendly humanoid robot with glowing blue eyes". */
  into: string;
  sfx?: SfxRole | false;
};

// Deterministic "noise" per frame, so every render of a frame is identical.
const noise = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** RGB split and sliced displacement: strong at the edges of the effect, gone in the middle. */
const Glitched: React.FC<{ src: string; amount: number; seed: number }> = ({ src, amount, seed }) => {
  const shift = amount * 22;
  const slices = amount > 0.05 ? [0, 1, 2, 3, 4, 5] : [];
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id="morph-r"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter>
        <filter id="morph-gb"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter>
      </svg>
      <Img src={src} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", filter: "url(#morph-r)", translate: `${shift}px 0`, mixBlendMode: "screen" }} />
      <Img src={src} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", filter: "url(#morph-gb)", translate: `${-shift}px 0`, mixBlendMode: "screen" }} />
      {slices.map(i => {
        const top = noise(seed * 7 + i) * 1800;
        const height = 20 + noise(seed * 13 + i) * 90;
        const dx = (noise(seed * 29 + i) - 0.5) * 160 * amount;
        return (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top, height, overflow: "hidden" }}>
            <Img src={src} style={{ position: "absolute", left: dx, top: -top, width: 1080, height: 1920 }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const Body: React.FC<{ from: number }> = ({ from }) => {
  const { assets } = useInput();
  const asset = useAsset();
  const { frame, fps, lengthFrames } = useClip();
  const key = `morph:${from.toFixed(2)}`;
  if (!assets[key]) return null;
  const src = asset(key);
  const edge = 0.28 * fps;
  const inAmount = interpolate(frame, [0, edge], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const outAmount = interpolate(frame, [lengthFrames - edge, lengthFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const amount = Math.max(inAmount, outAmount);
  // The first and last frames show the live author through the glitch, so the change reads as a transformation.
  const show = interpolate(frame, [0, 0.12 * fps, lengthFrames - 0.12 * fps, lengthFrames], [0.35, 1, 1, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const flash = interpolate(frame, [0, 0.06 * fps, 0.2 * fps], [0, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const breathe = interpolate(frame, [0, lengthFrames], [1, 1.035]);
  return (
    <>
      <CameraLayer>
        <AbsoluteFill style={{ opacity: show, scale: String(breathe) }}>
          <Glitched src={src} amount={amount} seed={Math.floor(frame / 2)} />
        </AbsoluteFill>
      </CameraLayer>
      <AbsoluteFill style={{ pointerEvents: "none", backgroundColor: "#bfe6ff", opacity: flash }} />
      <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.18 + 0.4 * amount,
        background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 5px)" }} />
    </>
  );
};

/**
 * The author turns into something for a moment (a robot when the AI acts) and back, with a glitch.
 * The picture is made from the author's own frame before rendering, so pose and room stay the same.
 */
export const Morph: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ from, to, sfx }) => (
  <>
    <Clip from={from} to={to} name="Morph"><Body from={from} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="glitch" />
    <BlockSfx at={Math.max(from, to - 0.25)} sfx={sfx} fallback="glitch" volume={0.6} />
  </>
);
Morph.layoutOf = () => ({});
