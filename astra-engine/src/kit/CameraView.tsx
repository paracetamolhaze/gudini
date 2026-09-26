import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  sfx?: SfxRole | false;
};

const Corner: React.FC<{ style: React.CSSProperties }> = ({ style }) => (
  <div style={{ position: "absolute", width: 110, height: 110, borderColor: "rgba(255,255,255,0.9)", borderStyle: "solid", ...style }} />
);

const Body: React.FC = () => {
  const { frame, fps, lengthFrames, elapsed, absolute } = useClip();
  const fade = Math.min(
    interpolate(frame, [0, 0.2 * fps], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(frame, [lengthFrames - 0.2 * fps, lengthFrames], [1, 0], { extrapolateLeft: "clamp" }),
  );
  const blink = Math.floor(elapsed * 2) % 2 === 0;
  const seconds = 3 * 3600 + 47 * 60 + 12 + absolute;
  const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map(n => String(n).padStart(2, "0")).join(":");
  const mono: React.CSSProperties = { fontFamily: "'Consolas','DejaVu Sans Mono',monospace", fontWeight: 700, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.8)" };
  return (
    <AbsoluteFill style={{ opacity: fade, pointerEvents: "none" }}>
      {/* Security-camera look over the live shot: desaturated, contrasty, with scanlines. */}
      <AbsoluteFill style={{ backdropFilter: "grayscale(0.75) contrast(1.25) brightness(0.92)" }} />
      <AbsoluteFill style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 2px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 5px)" }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)" }} />
      <Corner style={{ left: 70, top: 200, borderWidth: "6px 0 0 6px" }} />
      <Corner style={{ right: 170, top: 200, borderWidth: "6px 6px 0 0" }} />
      <Corner style={{ left: 70, bottom: 440, borderWidth: "0 0 6px 6px" }} />
      <Corner style={{ right: 170, bottom: 440, borderWidth: "0 6px 6px 0" }} />
      <div style={{ position: "absolute", left: 110, top: 240, display: "flex", alignItems: "center", gap: 16, ...mono, fontSize: 40 }}>
        <span style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.color.bad, opacity: blink ? 1 : 0.15, boxShadow: `0 0 18px ${theme.color.bad}` }} />
        REC
      </div>
      <div style={{ position: "absolute", right: 210, top: 244, ...mono, fontSize: 34 }}>{clock}</div>
    </AbsoluteFill>
  );
};

/** Security-camera overlay on the author: REC, timecode, frame corners. For "the camera sees / watches". */
export const CameraView: React.FC<Props> = ({ from, to, sfx }) => (
  <>
    <Clip from={from} to={to} name="CameraView"><Body /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="glitch" volume={0.35} />
  </>
);
