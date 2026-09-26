import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { theme } from "../theme";
import { useAsset } from "./assets";
import { BlockSfx, type SfxRole } from "./audio";
import { Icon } from "./List";
import { enter, leave, pop } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** Asset name or path of a logo or icon (PNG/SVG/WebP). */
  src?: string;
  /** Or a single emoji. */
  emoji?: string;
  /** Center of the icon on the 1080x1920 frame. Keep it off the face. */
  x: number;
  y: number;
  size?: number;
  label?: string;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ src, emoji, x, y, size = 200, label }) => {
  const { frame, fps, lengthFrames, elapsed } = useClip();
  const asset = useAsset();
  const s = pop(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.22);
  const bob = Math.sin(elapsed * Math.PI) * 6;
  const labelIn = enter(frame, fps, 0.35, 0.15);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2 + bob, width: size, height: size,
        scale: String(s * (0.6 + 0.4 * out)), opacity: out, rotate: `${(1 - Math.min(1, s)) * -14}deg` }}>
        {src ? <Img src={asset(src)} style={{ width: "100%", height: "100%", objectFit: "contain", filter: "drop-shadow(0 14px 30px rgba(0,0,0,0.45))" }} /> : null}
        {!src && emoji ? <Icon icon={emoji} size={size} /> : null}
      </div>
      {label ? (
        <div style={{ position: "absolute", left: x - 300, width: 600, top: y + size / 2 + 18, display: "flex", justifyContent: "center", opacity: labelIn * out }}>
          <span style={{ fontFamily: theme.font.text, fontWeight: 800, fontSize: 38, color: theme.color.text, backgroundColor: "rgba(13,17,21,0.82)", padding: "8px 20px", borderRadius: 14 }}>
            {label}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** A logo, icon or emoji pops in next to the author when its name is said. */
export const IconPop: React.FC<Props> = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Icon ${rest.label ?? rest.src ?? rest.emoji ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="pop" />
  </>
);
