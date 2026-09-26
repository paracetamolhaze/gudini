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
  /** bottom: the author glides up a little and the list rises from below; right: the author moves left and the list stands on the right. */
  side?: Side;
  /** Optional topic of the list, 1–3 words with meaning («Что сделал ИИ»); the list can go without a title. */
  title?: string;
  /** 2–4 items; each lights up at its `at`, when the author names it. */
  items?: ListItem[];
  numbered?: boolean;
  children?: React.ReactNode;
  sfx?: SfxRole | false;
};

// The list stands on the lower edge of the part of the screen TikTok leaves free.
const BOTTOM = 1480;
const LEFT = 60;
const MAX_WIDTH = 870;
const SIZE = 46;
const PAD = { y: 22, x: 26 };
// The author glides up just enough to show that the list came in from below.
const LIFT = 110;
const SHADOW = "0 2px 4px rgba(0,0,0,0.8), 0 6px 20px rgba(0,0,0,0.6)";

/** Height the list takes on screen, so the author and the captions make exactly that much room. */
export function listHeight(items: ListItem[] = [], title?: string, size = SIZE): number {
  const perLine = Math.floor((MAX_WIDTH - 2 * PAD.x - size * 1.15 - 60) / (size * 0.6));
  const lines = items.reduce((sum, item) => sum + Math.max(1, Math.ceil(item.text.length / perLine)), 0);
  const rows = lines * size * 1.12 + items.length * 2 * size * 0.22 + Math.max(0, items.length - 1) * 12;
  return 2 * PAD.y + rows + (title ? size * 1.4 * 1.05 + 14 : 0);
}

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
      {/* No background: a thin frame hugs the items and slides up with them; the shot stays visible inside. */}
      <div style={{
        position: "absolute", left: LEFT, bottom: 1920 - BOTTOM, maxWidth: MAX_WIDTH, padding: `${PAD.y}px ${PAD.x}px`,
        borderRadius: 30, border: "2px solid rgba(255,255,255,0.6)", boxShadow: "0 2px 14px rgba(0,0,0,0.3)",
        opacity: Math.min(1, shown * 1.4), translate: `0 ${(1 - shown) * 240}px`,
      }}>
        {title ? (
          <div style={{
            fontFamily: theme.font.display, fontWeight: 700, fontSize: SIZE * 1.4, lineHeight: 1.05, textTransform: "uppercase",
            color: theme.color.text, textShadow: SHADOW, marginBottom: 14, opacity: titleIn,
          }}>
            {title}
          </div>
        ) : null}
        {items?.length ? <List items={items} numbered={numbered} size={SIZE} gap={12} /> : null}
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** A compact list over the shot: the author glides up, a framed list rises from below; the item being said lights up. */
export const SidePanel: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`List ${rest.title ?? ""}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" />
  </>
);
SidePanel.layoutOf = ({ from, to, side = "bottom", items, title }) => side === "bottom"
  ? { occupied: { from, to, zone: "sheet", top: BOTTOM - listHeight(items, title) }, panel: { from, to, dx: 0, dy: -LIFT, zoom: 1 } }
  : { occupied: { from, to, zone: "right" }, panel: { from, to, dx: -250, dy: 0, zoom: 1 } };
