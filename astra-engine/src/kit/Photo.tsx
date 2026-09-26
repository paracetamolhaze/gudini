import React from "react";
import { ImageCard } from "./ImageCard";
import type { LayoutDeclaration } from "./AstraVideo";
import type { SfxRole } from "./audio";
import type { AstraInput } from "../input";

type Props = {
  from: number;
  to: number;
  /**
   * What the photo shows, in English, as for a stock photo search:
   * "police K9 german shepherd dog", "self-driving taxi on city street at night".
   */
  query: string;
  /** What must be visible for the photo to fit, in words: "the whole cabin, the driver's seat is empty". */
  look?: string;
  /** lower: card under the face while the author moves up; full: cutaway over the whole frame. */
  pos?: "lower" | "full";
  caption?: string;
  tilt?: number;
  /** Emoji shown instead if no photo fits the query. */
  fallback?: string;
  sfx?: SfxRole | false;
};

/** A real photo of what is being talked about, found for the query before rendering. */
export const Photo: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ query, look: _look, ...rest }) => (
  <ImageCard src={`photo:${query}`} {...rest} />
);
Photo.layoutOf = ({ from, to, pos = "lower", query }, input) => ImageCard.layoutOf({ from, to, pos, src: `photo:${query}` }, input);
