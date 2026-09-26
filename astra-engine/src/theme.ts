// Design tokens of the Astra style. One palette and one type system for every block,
// so a montage reads as designed even when Astra combines blocks in new ways.
export const theme = {
  color: {
    accent: "#FF6A1F",
    accent2: "#4C9DFF",
    highlight: "#FFD84A",
    ink: "#0D1115",
    panel: "rgba(13, 17, 21, 0.96)",
    text: "#FFFFFF",
    muted: "rgba(255, 255, 255, 0.72)",
    good: "#35D07F",
    bad: "#FF4D4D",
  },
  font: {
    display: "Oswald",
    text: "Montserrat",
    hand: "Caveat",
  },
  // TikTok interface zones on a 1080x1920 frame: status bar and tabs on top,
  // description and music line at the bottom, action buttons on the right.
  safe: { top: 170, bottom: 420, left: 60, right: 150 },
  radius: 38,
  shadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
} as const;

export type ColorName = keyof typeof theme.color;

/** Accepts a token name or any CSS color. */
export const color = (value: string | undefined, fallback: ColorName = "text"): string =>
  value === undefined ? theme.color[fallback] : value in theme.color ? theme.color[value as ColorName] : value;
