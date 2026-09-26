import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile } from "remotion";
import { faceOf, useInput } from "../input";
import { theme } from "../theme";
import { useAsset } from "./assets";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { CameraLayer, useHighestTop } from "./camera";
import { enter, leave, pop } from "./motion";
import { Clip, useClip, useClipOffset } from "./time";

type Props = {
  from: number;
  to: number;
  /** Brand or project name as it is written: "OpenAI", "Bitcoin", "Waymo", "Telegram". */
  name: string;
  /** above: over the head; behind: big, behind the author's head like a word behind the author. */
  pos?: "above" | "behind";
  size?: number;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "sfx">> = ({ from, to, name, pos = "above", size }) => {
  const { frame, fps, lengthFrames, elapsed } = useClip();
  const input = useInput();
  const asset = useAsset();
  const offset = useClipOffset();
  const highestTop = useHighestTop();
  const face = faceOf(input);
  const behind = pos === "behind";
  const side = size ?? (behind ? 560 : 200);
  const s = pop(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.22);
  const shine = enter(frame, fps, 0.9, 0.15);
  const bob = behind ? 0 : Math.sin(elapsed * Math.PI * 0.9) * 5;
  // Above the head: the tile sits between the TikTok top bar and the crown, wherever the camera puts it.
  const headTop = highestTop(face, from, to);
  const cy = behind ? face.y + face.h * 0.3 : Math.max(theme.safe.top + 20 + side / 2, headTop - 30 - side / 2);
  const cx = face.x + face.w / 2;
  const cutout = behind ? input.cutouts.find(c => c.from <= from + 0.05 && c.to >= to - 0.05) : undefined;
  return (
    <>
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div style={{
          position: "absolute", left: cx - side / 2, top: cy - side / 2 + bob, width: side, height: side, borderRadius: side * 0.24,
          backgroundColor: "#ffffff", boxShadow: "0 22px 50px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(255,255,255,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
          scale: String(s * (0.6 + 0.4 * out)), opacity: out, rotate: `${(1 - Math.min(1, s)) * -10}deg`,
        }}>
          <Img src={asset(`logo:${name.toLowerCase()}`)} style={{ width: "72%", height: "72%", objectFit: "contain" }} />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(115deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 65%)", translate: `${(shine * 2 - 1) * 140}% 0` }} />
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

/** A company or project logo on a white tile, over the head or big behind it. */
export const Logo: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Logo ${rest.name}`}><Body from={from} to={to} {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="pop" volume={0.45} />
  </>
);
Logo.layoutOf = ({ from, to }) => ({ occupied: { from, to, zone: "top" } });
