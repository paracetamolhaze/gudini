import React from "react";
import type { AstraInput } from "../input";
import type { LayoutDeclaration } from "./AstraVideo";
import type { SfxRole } from "./audio";
import { ImageCard } from "./ImageCard";

type Props = {
  from: number;
  to: number;
  /**
   * What to draw, one clear scene: "a white robotaxi with open windows, colorful gel beads flying out".
   * The style (bright cartoon, no text) is added automatically, so every illustration of a video matches.
   */
  prompt: string;
  /** lower: a square card over the lower part of the shot; full: over the whole frame. */
  pos?: "lower" | "full";
  /** Emoji shown instead if the illustration could not be made. */
  fallback?: string;
  sfx?: SfxRole | false;
};

const SQUARE = { x: 250, y: 985, w: 580, h: 580 };

/** A cartoon illustration drawn for this moment of the video before rendering. */
export const Illustration: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ prompt, pos = "lower", ...rest }) => (
  <ImageCard src={`gen:${prompt}`} pos={pos === "lower" ? SQUARE : "full"} tilt={-2} {...rest} />
);
Illustration.layoutOf = ({ from, to, pos = "lower", prompt }, input) =>
  input && !input.assets[`gen:${prompt}`] ? {} : pos === "full" ? { occupied: { from, to, zone: "full" } } : { occupied: { from, to, zone: "bottom" } };
