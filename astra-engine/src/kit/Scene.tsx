import React from "react";
import type { AstraInput } from "../input";
import type { LayoutDeclaration } from "./AstraVideo";
import type { SfxRole } from "./audio";
import { ImageCard } from "./ImageCard";

type Props = {
  from: number;
  to: number;
  /**
   * The moment of the story as a real photo would show it, with its facts:
   * "two 15-year-old boys in the back seat of a white Waymo, one leaning out of the open window firing a black toy Orbeez pistol, gel beads flying".
   * The look (photorealistic, vertical, subject whole and centered) is added automatically.
   */
  prompt: string;
  pos?: "full" | "lower";
  sfx?: SfxRole | false;
};

/** A realistic picture generated for this moment of the story before rendering. */
export const Scene: React.FC<Props> & { layoutOf: (p: Props, input?: AstraInput) => LayoutDeclaration } = ({ prompt, pos = "full", ...rest }) => (
  <ImageCard src={`scene:${prompt}`} pos={pos} {...rest} />
);
Scene.layoutOf = ({ from, to, pos = "full", prompt }, input) => ImageCard.layoutOf({ from, to, pos, src: `scene:${prompt}` }, input);
