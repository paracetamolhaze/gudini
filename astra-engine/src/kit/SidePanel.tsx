import React from "react";
import { AbsoluteFill } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { List, type ListItem } from "./List";
import { enter, glide, leave } from "./motion";
import { Clip, useClip } from "./time";

type Side = "bottom" | "right";
type Props = {
  from: number;
  to: number;
  /** bottom: the author moves up and the panel fills the lower half. right: the author moves left. */
  side?: Side;
  title?: string;
  items?: ListItem[];
  numbered?: boolean;
  children?: React.ReactNode;
  sfx?: SfxRole | false;
};

const SHIFT: Record<Side, { dx: number; dy: number }> = { bottom: { dx: 0, dy: -250 }, right: { dx: -250, dy: 0 } };

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ side = "bottom", title, items, numbered, children }) => {
  const { frame, fps, lengthFrames } = useClip();
  const slide = glide(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.35);
  const reveal = slide * out;
  const bottom = side === "bottom";
  const panel: React.CSSProperties = bottom
    ? { left: 0, right: 0, top: 1010, bottom: 0, borderRadius: `${theme.radius + 8}px ${theme.radius + 8}px 0 0`, translate: `0 ${(1 - reveal) * 105}%`, padding: "64px 70px 0 70px" }
    : { left: 540, right: 0, top: 0, bottom: 0, translate: `${(1 - reveal) * 105}% 0`, padding: "300px 56px 0 56px" };
  const titleIn = enter(frame, fps, 0.5, 0.15);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", ...panel, backgroundColor: theme.color.panel, boxShadow: theme.shadow, overflow: "hidden" }}>
        <div style={{
          position: "absolute", ...(bottom ? { left: 0, right: 0, top: 0, height: 5 } : { left: 0, top: 0, bottom: 0, width: 5 }),
          background: `linear-gradient(${bottom ? "90deg" : "180deg"}, ${theme.color.accent}, rgba(255,106,31,0))`,
        }} />
        {title ? (
          <div style={{
            fontFamily: theme.font.display, fontWeight: 700, fontSize: bottom ? 84 : 66, lineHeight: 1.02, textTransform: "uppercase",
            color: theme.color.accent, marginBottom: bottom ? 40 : 34, opacity: titleIn, translate: `0 ${(1 - titleIn) * 24}px`,
          }}>
            {title}
          </div>
        ) : null}
        {items?.length ? <List items={items} numbered={numbered} size={bottom ? 52 : 42} /> : null}
        {children}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Split screen: a panel slides in with a title and a list while the author moves aside.
 * Use it for steps, facts and comparisons the viewer should read.
 */
export const SidePanel: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Panel ${rest.title ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" />
  </>
);
SidePanel.layoutOf = ({ from, to, side = "bottom" }) => ({
  occupied: { from, to, zone: side },
  panel: { from, to, dx: SHIFT[side].dx, dy: SHIFT[side].dy, zoom: 1 },
});
