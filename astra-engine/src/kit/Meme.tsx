import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, interpolate, staticFile } from "remotion";
import { useInput, type AstraInput } from "../input";
import { theme } from "../theme";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { glide, leave } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** File name of the clip in the meme library (as listed in the task), without extension. */
  name: string;
  /** lower: card over the lower part; full: the whole frame; corner: small card beside the head. */
  pos?: "lower" | "full" | "corner";
  /** 0 = silent (default); up to 0.3 to let the meme's own sound peek through under the voice. */
  volume?: number;
  sfx?: SfxRole | false;
};

const BOX = { lower: { x: 90, y: 1000, w: 900, h: 506 }, corner: { x: 640, y: 380, w: 380, h: 380 } } as const;

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ name, pos = "lower", volume = 0 }) => {
  const { assets } = useInput();
  const { frame, fps, lengthFrames } = useClip();
  const file = assets[`meme:${name}`];
  if (!file) return null;
  const inP = glide(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.25);
  const video = <Video src={staticFile(file)} loop volume={volume} muted={volume === 0} objectFit="cover" style={{ width: "100%", height: "100%" }} />;
  if (pos === "full") {
    const fade = Math.min(interpolate(frame, [0, 0.2 * fps], [0, 1], { extrapolateRight: "clamp" }), out);
    return <AbsoluteFill style={{ opacity: fade, backgroundColor: theme.color.ink }}>{video}</AbsoluteFill>;
  }
  const box = BOX[pos];
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: theme.radius, overflow: "hidden",
        boxShadow: `${theme.shadow}, 0 0 0 5px rgba(255,255,255,0.92)`, backgroundColor: theme.color.ink,
        opacity: Math.min(1, inP * 1.4) * out, scale: String(0.85 + 0.15 * inP), rotate: `${(pos === "corner" ? 3 : -1.5) * inP}deg`,
      }}>
        {video}
      </div>
    </AbsoluteFill>
  );
};

/** A short meme clip from the owner's meme library, silent or quiet under the voice. */
export const Meme: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Meme ${rest.name}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="pop" />
  </>
);
Meme.layoutOf = ({ from, to, pos = "lower", name }, input) =>
  input && !input.assets[`meme:${name}`] ? {} : pos === "full" ? { occupied: { from, to, zone: "full" } } : pos === "lower" ? { occupied: { from, to, zone: "bottom" } } : {};
