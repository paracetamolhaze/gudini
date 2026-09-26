import { Easing, interpolate, spring } from "remotion";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Smooth arrival: fast start, long soft landing (expo-out). */
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
/** Smooth departure. */
export const EASE_IN = Easing.bezier(0.7, 0, 0.84, 0);
/** Camera moves: gentle at both ends. */
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

/** 0→1 over `seconds` after the clip starts. */
export function enter(frame: number, fps: number, seconds = 0.45, delay = 0): number {
  return interpolate(frame, [delay * fps, (delay + seconds) * fps], [0, 1], { ...clamp, easing: EASE_OUT });
}

/** 1→0 over the last `seconds` of a clip of `length` frames. */
export function leave(frame: number, fps: number, length: number, seconds = 0.3): number {
  return interpolate(frame, [length - seconds * fps, length], [1, 0], { ...clamp, easing: EASE_IN });
}

/** Springy pop with a little overshoot, for icons and stickers. */
export function pop(frame: number, fps: number, delay = 0): number {
  return spring({ frame: frame - delay * fps, fps, config: { damping: 11, stiffness: 170, mass: 0.7 } });
}

/** Calm spring without bounce, for panels and cards. */
export function glide(frame: number, fps: number, delay = 0): number {
  return spring({ frame: frame - delay * fps, fps, config: { damping: 200 } });
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
