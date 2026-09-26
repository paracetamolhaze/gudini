import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import type { LayoutDeclaration } from "./AstraVideo";
import { List, type ListItem } from "./List";
import { EASE_IN, enter, glide } from "./motion";
import { Clip, useClip } from "./time";

type Side = "bottom" | "right";
type Props = {
  from: number;
  to: number;
  /** bottom: the author glides up and the list rises from below; right: the author moves left and the list stands on the right. */
  side?: Side;
  /** Optional topic of the list, 1–3 words with meaning («Что сделал ИИ»); the list can go without a title. */
  title?: string;
  /** 2–4 items; each lights up at its `at`, when the author names it. */
  items?: ListItem[];
  numbered?: boolean;
  children?: React.ReactNode;
  sfx?: SfxRole | false;
};

// How far the author glides up: the head stays under the TikTok top bar, the chest goes under the list.
const LIFT = 250;
const SHEET_TOP = 960;
const SHADOW = "0 2px 4px rgba(0,0,0,0.75), 0 8px 26px rgba(0,0,0,0.6)";

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ side = "bottom", title, items, numbered, children }) => {
  const { frame, fps, lengthFrames } = useClip();
  const rise = glide(frame, fps, 0.05);
  const sink = interpolate(frame, [lengthFrames - 0.4 * fps, lengthFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN });
  const shown = Math.max(0, rise - sink);
  const titleIn = enter(frame, fps, 0.45, 0.2);
  if (side === "right") {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", opacity: shown }}>
        <div style={{ position: "absolute", left: 560, right: 60, top: 300, translate: `${(1 - shown) * 60}px 0` }}>
          {title ? <div style={{ fontFamily: theme.font.display, fontWeight: 700, fontSize: 64, lineHeight: 1.02, textTransform: "uppercase", color: theme.color.accent, textShadow: SHADOW, marginBottom: 22 }}>{title}</div> : null}
          {items?.length ? <List items={items} numbered={numbered} size={42} /> : null}
          {children}
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* The lower part fades into the dark design background; there is no box edge to see. */}
      <div style={{
        position: "absolute", left: 0, right: 0, top: SHEET_TOP - 140, bottom: 0, translate: `0 ${(1 - shown) * 1100}px`,
        background: "linear-gradient(180deg, rgba(8,11,20,0) 0px, rgba(8,11,20,0.9) 150px, rgba(8,11,20,0.97) 100%)",
      }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 12% 35%, rgba(255,106,31,0.22), rgba(255,106,31,0) 40%), radial-gradient(circle at 92% 90%, rgba(76,157,255,0.18), rgba(76,157,255,0) 40%)" }} />
      </div>
      <div style={{ position: "absolute", left: 60, right: 150, top: SHEET_TOP + 30, translate: `0 ${(1 - shown) * 900}px` }}>
        {title ? (
          <div style={{
            fontFamily: theme.font.display, fontWeight: 700, fontSize: 72, lineHeight: 1.02, textTransform: "uppercase",
            color: theme.color.text, marginBottom: 24, opacity: titleIn, translate: `${(1 - titleIn) * -30}px 0`,
          }}>
            {title}
          </div>
        ) : null}
        {items?.length ? <List items={items} numbered={numbered} size={50} gap={16} /> : null}
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** Split screen for a list: the author glides up, the list rises from below; the item being said lights up. */
export const SidePanel: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`List ${rest.title ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" />
  </>
);
SidePanel.layoutOf = ({ from, to, side = "bottom" }) => side === "bottom"
  ? { occupied: { from, to, zone: "sheet" }, panel: { from, to, dx: 0, dy: -LIFT, zoom: 1 } }
  : { occupied: { from, to, zone: "right" }, panel: { from, to, dx: -250, dy: 0, zoom: 1 } };
