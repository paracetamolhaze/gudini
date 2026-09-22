import { env } from "../config/env.js";
import type { Settings } from "../config/settings.js";
import { threadsAdapter } from "./threads.js";
import { xAdapter } from "./x.js";
import { xBrowserAdapter } from "./xBrowser.js";
import { PLATFORM_IDS, type PlatformAdapter, type PlatformId } from "./types.js";

/**
 * Which X we talk to. The browser transport is the normal one: our own Chromium holds the owner's
 * login, so there is no bill and no developer keys. The paid API adapter stays reachable through
 * X_TRANSPORT=api for the case where the browser cannot be used. Resolved on first use, not at
 * import: reading the environment while modules load would make every importer need a full .env.
 */
const defaultAdapter = (id: PlatformId): PlatformAdapter => (id === "threads" ? threadsAdapter : env().X_TRANSPORT === "api" ? xAdapter : xBrowserAdapter);

/** Registry of outlets. Tests swap an adapter for a fake; production code never names a concrete client. */
const adapters = new Map<PlatformId, PlatformAdapter>();

export function platform(id: PlatformId): PlatformAdapter {
  const existing = adapters.get(id);
  if (existing) return existing;
  if (!(PLATFORM_IDS as readonly string[]).includes(id)) throw new Error(`unknown platform ${id}`);
  const fresh = defaultAdapter(id);
  adapters.set(id, fresh);
  return fresh;
}

export function setPlatformForTests(id: PlatformId, adapter: PlatformAdapter | null): void {
  if (adapter) adapters.set(id, adapter);
  else adapters.delete(id);
}

export function platformEnabled(settings: Settings, id: PlatformId): boolean {
  return settings.platforms[id].enabled;
}

/** Enabled in settings AND holding credentials: the platforms that can actually act right now. */
export function activePlatforms(settings: Settings): PlatformAdapter[] {
  return PLATFORM_IDS.filter((id) => platformEnabled(settings, id))
    .map((id) => platform(id))
    .filter((a) => a.configured());
}

/**
 * Targets for a new draft: the platforms that can publish right now. While nothing is connected yet
 * every enabled platform is targeted, so the draft shows what it is waiting for instead of hiding it.
 */
export function defaultTargets(settings: Settings): PlatformId[] {
  const enabled = PLATFORM_IDS.filter((id) => platformEnabled(settings, id));
  const ready = enabled.filter((id) => platform(id).configured());
  if (ready.length) return [...ready];
  return enabled.length ? [...enabled] : ["threads"];
}

export * from "./types.js";
export { PublishUnknownStateError } from "./attempts.js";
