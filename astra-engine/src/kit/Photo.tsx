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
  /** lower: card under the face while the author moves up; full: cutaway over the whole frame. */
  pos?: "lower" | "full";
  caption?: string;
  tilt?: number;
  /** Emoji shown instead if no photo fits the query. */
  fallback?: string;
  sfx?: SfxRole | false;
};

/** A real photo of what is being talked about, found for the query before rendering. */
export const Photo: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ query, ...rest }) => (
  <ImageCard src={`photo:${query}`} {...rest} />
);
Photo.layoutOf = ({ from, to, pos = "lower", query }, input) => ImageCard.layoutOf({ from, to, pos, src: `photo:${query}` }, input);
