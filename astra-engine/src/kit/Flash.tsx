import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { BlockSfx, type SfxRole } from "./audio";
import { Clip, useClip } from "./time";

const Body: React.FC<{ tint: string }> = ({ tint }) => {
  const { frame, fps } = useClip();
  const opacity = interpolate(frame, [0, 0.04 * fps, 0.22 * fps], [0, 0.85, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ backgroundColor: tint, opacity, pointerEvents: "none" }} />;
};

/** Short light flash on a hard accent or a cut into a new part. Use rarely. */
export const Flash: React.FC<{ at: number; tint?: string; sfx?: SfxRole | false }> = ({ at, tint = "#ffffff", sfx }) => (
  <>
    <Clip from={at} to={at + 0.25} name="Flash"><Body tint={tint} /></Clip>
    <BlockSfx at={at} sfx={sfx} fallback="impact" />
  </>
);
