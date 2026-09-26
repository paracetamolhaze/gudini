import React, { createContext, useContext } from "react";
import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { useInput } from "../input";

const OffsetContext = createContext(0);

/**
 * Shows its children between `from` and `to` seconds of the video.
 * Inside, `useClip()` gives local progress and absolute time.
 */
export const Clip: React.FC<{ from: number; to: number; name?: string; children: React.ReactNode }> = ({ from, to, name, children }) => {
  const { fps } = useVideoConfig();
  const parent = useContext(OffsetContext);
  const start = Math.max(0, Math.round(from * fps));
  const length = Math.max(1, Math.round(to * fps) - start);
  return (
    <Sequence from={start - parent} durationInFrames={length} name={name} premountFor={Math.round(fps)}>
      <OffsetContext.Provider value={start}>{children}</OffsetContext.Provider>
    </Sequence>
  );
};

/** Frame counted from the start of the whole video, also inside clips. */
export function useAbsoluteFrame(): number {
  return useContext(OffsetContext) + useCurrentFrame();
}

/** Start frame of the enclosing clip: nested `<Sequence from>` values are relative to it. */
export function useClipOffset(): number {
  return useContext(OffsetContext);
}

/** Local timing of the enclosing clip: seconds since it started and until it ends. */
export function useClip() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const offset = useContext(OffsetContext);
  return {
    fps,
    frame,
    elapsed: frame / fps,
    remaining: (durationInFrames - frame) / fps,
    length: durationInFrames / fps,
    lengthFrames: durationInFrames,
    absolute: (offset + frame) / fps,
  };
}

/** Start time of word `index` (0-based, same numbering as in the transcript Astra received). */
export function useWordTime() {
  const { words } = useInput();
  return {
    start: (index: number) => words[Math.max(0, Math.min(words.length - 1, index))]?.start ?? 0,
    end: (index: number) => words[Math.max(0, Math.min(words.length - 1, index))]?.end ?? 0,
  };
}
