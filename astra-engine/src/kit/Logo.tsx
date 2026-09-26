import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { useAsset } from "./assets";
import { BlockSfx, type SfxRole } from "./audio";
import { enter, leave, pop } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** Brand or project name as it is written: "OpenAI", "Bitcoin", "Waymo", "Telegram". */
  name: string;
  /** Center of the logo on the 1080x1920 frame; keep it beside the head. */
  x: number;
  y: number;
  size?: number;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ name, x, y, size = 230 }) => {
  const { frame, fps, lengthFrames, elapsed } = useClip();
  const asset = useAsset();
  const s = pop(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.22);
  const shine = enter(frame, fps, 0.9, 0.15);
  const bob = Math.sin(elapsed * Math.PI * 0.9) * 5;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: x - size / 2, top: y - size / 2 + bob, width: size, height: size, borderRadius: size * 0.24,
        backgroundColor: "#ffffff", boxShadow: `0 22px 50px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(255,255,255,0.6)`,
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
        scale: String(s * (0.6 + 0.4 * out)), opacity: out, rotate: `${(1 - Math.min(1, s)) * -10}deg`,
      }}>
        <Img src={asset(`logo:${name.toLowerCase()}`)} style={{ width: "72%", height: "72%", objectFit: "contain" }} />
        {/* A light sweep across the tile once it lands. */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(115deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 65%)", translate: `${(shine * 2 - 1) * 140}% 0` }} />
      </div>
    </AbsoluteFill>
  );
};

/** A company or project logo on a white tile, popping in when the name is said. */
export const Logo: React.FC<Props> = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Logo ${rest.name}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="pop" volume={0.45} />
  </>
);
