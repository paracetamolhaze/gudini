import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, interpolate, staticFile } from "remotion";
import { faceOf, useInput } from "../input";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { List, type ListItem } from "./List";
import { EASE_IN_OUT, EASE_OUT, pop } from "./motion";
import { Clip, useClip, useClipOffset } from "./time";

type Props = {
  from: number;
  to: number;
  /** Heading of the card, two to five words. */
  title: string;
  items?: ListItem[];
  numbered?: boolean;
  children?: React.ReactNode;
  sfx?: SfxRole | false;
};

const PIP = { size: 360, x: 660, y: 210 };

/** The author keeps talking in a circle while the card fills the frame. */
const AuthorCircle: React.FC<{ scale: number }> = ({ scale }) => {
  const input = useInput();
  const face = faceOf(input);
  const offset = useClipOffset();
  const zoom = PIP.size / (face.w * 1.5);
  const cx = face.x + face.w / 2, cy = face.y + face.h * 0.45;
  return (
    <div style={{
      position: "absolute", left: PIP.x, top: PIP.y, width: PIP.size, height: PIP.size, borderRadius: "50%", overflow: "hidden",
      scale: String(scale), boxShadow: `0 0 0 6px ${theme.color.accent}, ${theme.shadow}`, backgroundColor: theme.color.ink,
    }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1920, transformOrigin: "0 0",
        scale: String(zoom), translate: `${PIP.size / 2 - cx * zoom}px ${PIP.size / 2 - cy * zoom}px` }}>
        <Video src={staticFile(input.video)} muted trimBefore={offset} objectFit="cover" style={{ width: 1080, height: 1920 }} />
      </div>
    </div>
  );
};

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ title, items, numbered = true, children }) => {
  const { frame, fps, lengthFrames } = useClip();
  // The author's circle pops first, then the card grows out of it; on exit it folds back into the circle.
  const open = interpolate(frame, [0.12 * fps, 0.7 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  const close = interpolate(frame, [lengthFrames - 0.45 * fps, lengthFrames - 0.1 * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN_OUT });
  const radius = PIP.size / 2 + 2300 * Math.min(open, close);
  const circleIn = pop(frame, fps) * interpolate(frame, [lengthFrames - 0.12 * fps, lengthFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleIn = interpolate(frame, [0.3 * fps, 0.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  const cardOpacity = interpolate(frame, [0.1 * fps, 0.25 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: cardOpacity, clipPath: `circle(${radius}px at ${PIP.x + PIP.size / 2}px ${PIP.y + PIP.size / 2}px)` }}>
        <AbsoluteFill style={{ background: `radial-gradient(circle at 15% 8%, rgba(255,106,31,0.16), rgba(255,106,31,0) 55%), ${theme.color.ink}` }} />
        <div style={{
          position: "absolute", left: 70, top: 290, width: 560,
          fontFamily: theme.font.display, fontWeight: 700, fontSize: 104, lineHeight: 1, textTransform: "uppercase", color: theme.color.accent,
          opacity: titleIn, translate: `0 ${(1 - titleIn) * 30}px`,
        }}>
          {title}
        </div>
        <div style={{ position: "absolute", left: 70, right: 90, top: 700 }}>
          {items?.length ? <List items={items} numbered={numbered} size={74} font="display" gap={22} /> : null}
          {children}
        </div>
      </AbsoluteFill>
      <AuthorCircle scale={circleIn} />
    </AbsoluteFill>
  );
};

/** Full-screen card with a title and a list; the author stays in a circle. For key summaries. */
export const FocusCard: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Card ${rest.title}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" />
  </>
);
FocusCard.layoutOf = ({ from, to }) => ({ occupied: { from, to, zone: "full" } });
