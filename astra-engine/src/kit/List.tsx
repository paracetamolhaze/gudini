import React from "react";
import { Img, interpolate } from "remotion";
import { color, theme } from "../theme";
import { useAsset } from "./assets";
import { EASE_OUT } from "./motion";
import { useClip } from "./time";

export const EMOJI_FONT = "'Noto Color Emoji','Segoe UI Emoji','Apple Color Emoji',sans-serif";
/** An icon is either a file (logo, picture) or an emoji written as text. */
const isImage = (icon: string) => /\.(png|jpe?g|webp|svg|gif|avif)$/i.test(icon) || icon.includes("/") || /^[\w-]+$/.test(icon);

export type ListItem = {
  text: string;
  /** Second of the video when the item appears; say it and show it together. */
  at?: number;
  /** Asset name or path of a small icon or logo shown before the text. */
  icon?: string;
  /** Text color token: accent for the conclusion, good / bad for pros and cons. */
  tone?: string;
};

/** Items appear one by one at their `at` time (or every 0.4 s), sliding in from the left. */
export const List: React.FC<{ items: ListItem[]; size?: number; numbered?: boolean; font?: "display" | "text"; gap?: number }> = ({
  items, size = 52, numbered = false, font = "text", gap = 26,
}) => {
  const { fps, frame, absolute } = useClip();
  const asset = useAsset();
  const clipStart = absolute - frame / fps;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {items.map((item, i) => {
        const start = item.at !== undefined ? item.at - clipStart : 0.35 + i * 0.4;
        const p = interpolate(frame, [start * fps, (start + 0.4) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 22, opacity: p, translate: `${(1 - p) * -40}px 0`, filter: `blur(${(1 - p) * 6}px)` }}>
            {numbered ? (
              <span style={{ fontFamily: theme.font.text, fontWeight: 800, fontSize: size * 0.5, color: theme.color.accent, minWidth: size * 0.9 }}>
                {String(i + 1).padStart(2, "0")}
              </span>
            ) : null}
            {item.icon && isImage(item.icon) ? <Img src={asset(item.icon)} style={{ width: size * 1.15, height: size * 1.15, objectFit: "contain" }} /> : null}
            {item.icon && !isImage(item.icon) ? (
              <span style={{ fontSize: size * 1.0, lineHeight: 1, width: size * 1.15, textAlign: "center", fontFamily: EMOJI_FONT }}>{item.icon}</span>
            ) : null}
            <span style={{
              fontFamily: font === "display" ? theme.font.display : theme.font.text,
              fontWeight: font === "display" ? 700 : 800, fontSize: size, lineHeight: 1.12,
              textTransform: font === "display" ? "uppercase" : "none",
              color: color(item.tone, "text"),
            }}>
              {item.text}
            </span>
          </div>
        );
      })}
    </div>
  );
};
