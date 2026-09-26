import React from "react";
import { Img, interpolate } from "remotion";
import { useInput } from "../input";
import { theme } from "../theme";
import { useAsset } from "./assets";
import { EASE_OUT } from "./motion";
import { useClip } from "./time";

export const EMOJI_FONT = "'Noto Color Emoji','Segoe UI Emoji','Apple Color Emoji',sans-serif";
const isFile = (icon: string) => /\.(png|jpe?g|webp|svg|gif|avif)$/i.test(icon) || icon.includes("/");

/**
 * An icon for lists and stickers: a prepared 3D emoji or logo from the job's assets,
 * a file path, or plain emoji text as the last resort.
 */
export const Icon: React.FC<{ icon: string; size: number }> = ({ icon, size }) => {
  const { assets } = useInput();
  const asset = useAsset();
  const logo = `logo:${icon.toLowerCase()}`;
  const key = assets[`emoji:${icon}`] ? `emoji:${icon}` : assets[logo] ? logo : assets[icon] ? icon : isFile(icon) ? icon : null;
  if (key) return <Img src={asset(key)} style={{ width: size, height: size, objectFit: "contain", filter: "drop-shadow(0 8px 16px rgba(0,0,0,0.35))" }} />;
  return <span style={{ fontSize: size * 0.86, lineHeight: 1, width: size, textAlign: "center", fontFamily: EMOJI_FONT }}>{icon}</span>;
};

export type ListItem = {
  text: string;
  /** Second of the video when the author starts saying this item: the highlight moves to it. */
  at?: number;
  /** Optional logo name or picture from the materials, shown before the text. */
  icon?: string;
};

const SHADOW = "0 2px 4px rgba(0,0,0,0.75), 0 6px 22px rgba(0,0,0,0.6)";

/**
 * All items are on screen in white; the one being said right now lights up in the accent color,
 * and the light moves on to the next item as the author names it.
 */
export const List: React.FC<{ items: ListItem[]; size?: number; numbered?: boolean; gap?: number }> = ({
  items, size = 50, numbered = false, gap = 14,
}) => {
  const { fps, frame, absolute: t } = useClip();
  const active = items.reduce((found, item, i) => (item.at !== undefined && item.at <= t ? i : found), -1);
  const dot = size * 1.15;
  const lineIn = interpolate(frame, [0.2 * fps, (0.6 + items.length * 0.09) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap, position: "relative" }}>
      {/* Numbered lists read as a chain: numbers sit on one line that grows down through them. */}
      {numbered ? (
        <div style={{ position: "absolute", left: size * 0.42 + dot / 2 - 2, top: dot / 2, width: 4, height: `calc(${lineIn * 100}% - ${dot}px)`,
          borderRadius: 2, background: "linear-gradient(180deg, rgba(255,106,31,0.9), rgba(255,255,255,0.25))" }} />
      ) : null}
      {items.map((item, i) => {
        // Items arrive together at the start, one after another in a quick cascade.
        const p = interpolate(frame, [(0.15 + i * 0.09) * fps, (0.55 + i * 0.09) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
        const lit = item.at === undefined ? 0 : Math.min(
          interpolate(t, [item.at - 0.05, item.at + 0.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          i === active ? 1 : interpolate(t, [(items[active]?.at ?? Infinity) - 0.05, (items[active]?.at ?? Infinity) + 0.2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        );
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 18, alignSelf: "flex-start",
            padding: `${size * 0.22}px ${size * 0.42}px`, borderRadius: 20,
            backgroundColor: `rgba(255,106,31,${0.95 * lit})`, boxShadow: lit > 0.01 ? `0 10px 30px rgba(255,106,31,${0.35 * lit})` : "none",
            opacity: p, translate: `${(1 - p) * -40}px 0`, scale: String(1 + 0.04 * lit), transformOrigin: "left center",
          }}>
            {numbered ? (
              <span style={{
                width: dot, height: dot, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: theme.font.text, fontWeight: 800, fontSize: size * 0.5, color: theme.color.text,
                backgroundColor: lit > 0.5 ? theme.color.ink : "rgba(10,14,22,0.85)",
                boxShadow: `inset 0 0 0 3px ${lit > 0.5 ? theme.color.text : "rgba(255,255,255,0.35)"}`,
              }}>
                {i + 1}
              </span>
            ) : null}
            {item.icon ? <Icon icon={item.icon} size={size * 1.2} /> : null}
            <span style={{
              fontFamily: theme.font.text, fontWeight: 800, fontSize: size, lineHeight: 1.12,
              color: theme.color.text, textShadow: lit > 0.5 ? "0 2px 6px rgba(0,0,0,0.25)" : SHADOW,
            }}>
              {item.text}
            </span>
          </div>
        );
      })}
    </div>
  );
};
