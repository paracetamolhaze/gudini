import React, { createContext, useContext } from "react";
import { AbsoluteFill, interpolate, useVideoConfig } from "remotion";
import { EASE_IN_OUT, EASE_OUT } from "./motion";
import { useAbsoluteFrame } from "./time";

export type CamState = { zoom: number; x: number; y: number };
export type CamMove =
  | { kind: "ease"; from: number; to: number; target: Partial<CamState> }
  | { kind: "cut"; at: number; target: Partial<CamState> };

/**
 * Camera language for the author shot. Times are seconds of the video.
 * Moves must not overlap; between moves the camera holds its framing.
 */
export const cam = {
  /** Slow push-in, e.g. the opening of a video: `cam.push(0, 3, 1.12)`. */
  push: (from: number, to: number, zoom = 1.12): CamMove => ({ kind: "ease", from, to, target: { zoom } }),
  /** Slow pull back to a wider framing. */
  pull: (from: number, to: number, zoom = 1): CamMove => ({ kind: "ease", from, to, target: { zoom } }),
  /** Hard punch-in on an accent word, like a jump cut to a closer shot. */
  punch: (at: number, zoom = 1.2): CamMove => ({ kind: "cut", at, target: { zoom } }),
  /** Hard cut back to the base framing. */
  reset: (at: number): CamMove => ({ kind: "cut", at, target: { zoom: 1, x: 0, y: 0 } }),
  /** Free smooth move: zoom plus offset in pixels (x right, y down). */
  move: (from: number, to: number, target: Partial<CamState>): CamMove => ({ kind: "ease", from, to, target }),
};

type Key = CamState & { t: number; eased: boolean };

export function buildKeys(moves: CamMove[]): Key[] {
  const sorted = [...moves].sort((a, b) => (a.kind === "cut" ? a.at : a.from) - (b.kind === "cut" ? b.at : b.from));
  let state: CamState = { zoom: 1, x: 0, y: 0 };
  const keys: Key[] = [{ t: 0, ...state, eased: false }];
  for (const move of sorted) {
    if (move.kind === "cut") {
      keys.push({ t: move.at, ...state, eased: false });
      state = { ...state, ...move.target };
      keys.push({ t: move.at, ...state, eased: false });
    } else {
      keys.push({ t: move.from, ...state, eased: false });
      state = { ...state, ...move.target };
      keys.push({ t: Math.max(move.from + 0.01, move.to), ...state, eased: true });
    }
  }
  return keys;
}

export function evalKeys(keys: Key[], t: number): CamState {
  let index = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].t <= t) index = i;
  const current = keys[index];
  const next = keys[index + 1];
  if (!next || !next.eased || t >= next.t) return current;
  const p = interpolate(t, [current.t, next.t], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN_OUT });
  return {
    zoom: current.zoom + (next.zoom - current.zoom) * p,
    x: current.x + (next.x - current.x) * p,
    y: current.y + (next.y - current.y) * p,
  };
}

/** A panel window shifts the author out of the panel's way for its duration. */
export type PanelWindow = { from: number; to: number; dx: number; dy: number; zoom: number };

export type CameraSetup = { keys: Key[]; panels: PanelWindow[]; origin: { x: number; y: number } };
export const CameraContext = createContext<CameraSetup>({ keys: buildKeys([]), panels: [], origin: { x: 540, y: 700 } });

function panelOffset(panels: PanelWindow[], t: number) {
  let dx = 0, dy = 0, zoom = 1;
  for (const p of panels) {
    const inP = interpolate(t, [p.from - 0.05, p.from + 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_OUT });
    const outP = interpolate(t, [p.to - 0.45, p.to], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN_OUT });
    const k = Math.min(inP, outP);
    dx += p.dx * k; dy += p.dy * k; zoom *= 1 + (p.zoom - 1) * k;
  }
  return { dx, dy, zoom };
}

/** Camera state at the current frame: zoom around `origin`, then shift. */
export function useCameraState() {
  const { fps } = useVideoConfig();
  const frame = useAbsoluteFrame();
  const { keys, panels, origin } = useContext(CameraContext);
  const t = frame / fps;
  const base = evalKeys(keys, t);
  const panel = panelOffset(panels, t);
  return { zoom: base.zoom * panel.zoom, x: base.x + panel.dx, y: base.y + panel.dy, origin };
}

/** Transform of the author shot at the current frame; shared by every layer that shows the author. */
export function useCameraStyle(): React.CSSProperties {
  const { zoom, x, y, origin } = useCameraState();
  return { transformOrigin: `${origin.x}px ${origin.y}px`, scale: String(zoom), translate: `${x}px ${y}px` };
}

/** Highest on-screen top edge of a source box during [from, to]: layouts use it to stay clear of the head. */
export function useHighestTop() {
  const { keys, panels, origin } = useContext(CameraContext);
  return (box: { y: number }, from: number, to: number) => {
    let top = Infinity;
    for (let i = 0; i <= 8; i++) {
      const t = from + ((to - from) * i) / 8;
      const base = evalKeys(keys, t);
      const panel = panelOffset(panels, t);
      top = Math.min(top, origin.y + (box.y - origin.y) * base.zoom * panel.zoom + base.y + panel.dy);
    }
    return top;
  };
}

/** Where a box of the source frame (e.g. the head) is on screen right now, after zoom and shift. */
export function useOnScreen(box: { x: number; y: number; w: number; h: number }) {
  const { zoom, x, y, origin } = useCameraState();
  const map = (px: number, py: number) => ({ x: origin.x + (px - origin.x) * zoom + x, y: origin.y + (py - origin.y) * zoom + y });
  const a = map(box.x, box.y), b = map(box.x + box.w, box.y + box.h);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

export const CameraLayer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const style = useCameraStyle();
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};
