import fs from "node:fs";
import path from "node:path";

/**
 * X through our own browser: a dedicated Chromium profile lives in its container and holds the
 * owner's login. The paid X API takes no part here — no keys, no bill for reading other people.
 */
export const X_BROWSER_DIR = path.join(process.env.DATA_DIR || "./data", "x-browser");
export const X_PROFILE_DIR = path.join(X_BROWSER_DIR, "profile");

export type XSessionState = {
  connected: boolean;
  /** Handle without the @, as X spells it. */
  username?: string;
  displayName?: string;
  /** When a live page last confirmed the login. */
  checkedAt?: string;
  /** Why the session was lost, in the owner's words. */
  issue?: string;
};

const FILE = () => path.join(X_BROWSER_DIR, "state.json");

export function readXSession(): XSessionState {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8")) as XSessionState;
  } catch {
    // A missing or corrupt file means "not connected", never an empty session under someone's name.
    return { connected: false };
  }
}

export function writeXSession(state: XSessionState): void {
  fs.mkdirSync(X_BROWSER_DIR, { recursive: true, mode: 0o700 });
  const file = FILE();
  fs.writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

/** Exact fixed child of our own directory; never an arbitrary caller-supplied path. */
export function removeXProfile(): void {
  const profile = path.resolve(X_PROFILE_DIR);
  if (path.dirname(profile) !== path.resolve(X_BROWSER_DIR)) throw new Error("Некорректный путь профиля");
  fs.rmSync(profile, { recursive: true, force: true });
}
