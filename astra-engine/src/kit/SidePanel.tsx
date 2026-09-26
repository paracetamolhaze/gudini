import React from "react";
import { AbsoluteFill } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { List, type ListItem } from "./List";
import { enter, leave } from "./motion";
import { Clip, useClip } from "./time";

type Side = "bottom" | "right";
type Props = {
  from: number;
  to: number;
  /** bottom: the list stands over the lower part of the frame; right: the author moves left to make room. */
  side?: Side;
  /** Short topic of the list, 1–3 words. */
  title?: string;
  /** 2–4 items; each lights up at its `at`, when the author names it. */
  items?: ListItem[];
  numbered?: boolean;
  children?: React.ReactNode;
  sfx?: SfxRole | false;
};

const SHADOW = "0 2px 4px rgba(0,0,0,0.75), 0 8px 26px rgba(0,0,0,0.6)";

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ side = "bottom", title, items, numbered, children }) => {
  const { frame, fps, lengthFrames } = useClip();
  const inP = enter(frame, fps, 0.45);
  const out = leave(frame, fps, lengthFrames, 0.3);
  const box: React.CSSProperties = side === "bottom" ? { left: 60, right: 150, top: 990 } : { left: 560, right: 60, top: 300 };
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: out }}>
      {/* No panel behind the list: the words stand over the shot itself. */}
      <div style={{ position: "absolute", ...box, translate: `0 ${(1 - out) * 20}px` }}>
        {title ? (
          <div style={{
            fontFamily: theme.font.display, fontWeight: 700, fontSize: side === "bottom" ? 80 : 64, lineHeight: 1.02, textTransform: "uppercase",
            color: theme.color.accent, textShadow: SHADOW, marginBottom: 22, opacity: inP, translate: `${(1 - inP) * -30}px 0`,
          }}>
            {title}
          </div>
        ) : null}
        {items?.length ? <List items={items} numbered={numbered} size={side === "bottom" ? 50 : 42} /> : null}
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** A list over the shot: every item white, the one being said lights up. For steps, reasons, contents. */
export const SidePanel: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`List ${rest.title ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" volume={0.4} />
  </>
);
SidePanel.layoutOf = ({ from, to, side = "bottom" }) => side === "bottom"
  ? { occupied: { from, to, zone: "bottom" } }
  : { occupied: { from, to, zone: "right" }, panel: { from, to, dx: -250, dy: 0, zoom: 1 } };
