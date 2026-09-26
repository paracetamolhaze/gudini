import React from "react";
import { AbsoluteFill } from "remotion";
import { theme } from "../theme";
import { BlockSfx, type SfxRole } from "./audio";
import { Icon } from "./List";
import { glide, leave } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** Who sends it: an app, a car, a bank, a chat. */
  app: string;
  title: string;
  text: string;
  /** Emoji or logo name for the app icon. */
  icon?: string;
  /** Small time label on the right, e.g. "сейчас". */
  time?: string;
  /** Vertical position of the banner top; by default right under the TikTok top bar. */
  top?: number;
  sfx?: SfxRole | false;
};

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ app, title, text, icon, time = "сейчас", top = 200 }) => {
  const { frame, fps, lengthFrames } = useClip();
  const inP = glide(frame, fps);
  const out = leave(frame, fps, lengthFrames, 0.3);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: 60, right: 60, top, borderRadius: 44, padding: "30px 34px",
        background: "rgba(245,245,248,0.84)", backdropFilter: "blur(30px) saturate(1.6)",
        boxShadow: "0 24px 60px rgba(0,0,0,0.35)", display: "flex", gap: 26, alignItems: "flex-start",
        translate: `0 ${(1 - inP) * -260 + (1 - out) * -60}px`, opacity: Math.min(inP * 1.5, out), scale: String(0.94 + 0.06 * inP),
      }}>
        <div style={{ width: 96, height: 96, borderRadius: 24, backgroundColor: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.08)", flexShrink: 0 }}>
          {icon ? <Icon icon={icon} size={74} /> : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, fontFamily: theme.font.text, color: "#111217" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, fontWeight: 700, color: "rgba(17,18,23,0.55)", marginBottom: 6 }}>
            <span style={{ textTransform: "uppercase", letterSpacing: 1 }}>{app}</span>
            <span style={{ textTransform: "none" }}>{time}</span>
          </div>
          <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
          <div style={{ fontSize: 38, fontWeight: 600, lineHeight: 1.2, color: "rgba(17,18,23,0.8)", marginTop: 4 }}>{text}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A phone or car-screen notification sliding in from the top: messages, alerts, system prompts. */
export const Notification: React.FC<Props> = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Notification ${rest.title}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="notification" />
  </>
);
