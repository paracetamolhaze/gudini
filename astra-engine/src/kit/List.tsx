import React from "react";
import { Img, interpolate } from "remotion";
import { useInput } from "../input";
import { color, theme } from "../theme";
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
  /** Second of the video when the item appears; say it and show it together. */
  at?: number;
  /** An emoji (drawn as a 3D icon), a logo name, or an asset name. */
  icon?: string;
  /** Text color token: accent for the conclusion, good / bad for pros and cons. */
  tone?: string;
};

/** Items appear one by one at their `at` time (or every 0.4 s) as glass rows with icons. */
export const List: React.FC<{ items: ListItem[]; size?: number; numbered?: boolean; font?: "display" | "text"; gap?: number }> = ({
  items, size = 50, numbered = false, font = "text", gap = 18,
}) => {
  const { fps, frame, absolute } = useClip();
  const clipStart = absolute - frame / fps;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {items.map((item, i) => {
        const start = item.at !== undefined ? item.at - clipStart : 0.35 + i * 0.4;
        const p = interpolate(frame, [start * fps, (start + 0.45) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 20, padding: `${size * 0.28}px ${size * 0.45}px`,
            borderRadius: 24, backgroundColor: "rgba(255,255,255,0.08)", boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.13)",
            opacity: p, translate: `${(1 - p) * -46}px 0`, filter: `blur(${(1 - p) * 6}px)`,
          }}>
            {numbered ? (
              <span style={{ fontFamily: theme.font.text, fontWeight: 800, fontSize: size * 0.5, color: theme.color.accent, minWidth: size * 0.8 }}>
                {String(i + 1).padStart(2, "0")}
              </span>
            ) : null}
            {item.icon ? <Icon icon={item.icon} size={size * 1.3} /> : null}
            <span style={{
              fontFamily: font === "display" ? theme.font.display : theme.font.text,
              fontWeight: font === "display" ? 700 : 800, fontSize: size, lineHeight: 1.12,
              textTransform: font === "display" ? "uppercase" : "none",
              color: color(item.tone, "text"), textShadow: "0 2px 10px rgba(0,0,0,0.35)",
            }}>
              {item.text}
            </span>
          </div>
        );
      })}
    </div>
  );
};
