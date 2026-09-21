import type { Settings } from "../config/settings.js";
import { threadsAdapter } from "./threads.js";
import { xAdapter } from "./x.js";
import { PLATFORM_IDS, type PlatformAdapter, type PlatformId } from "./types.js";

/** Registry of outlets. Tests swap an adapter for a fake; production code never names a concrete client. */
const adapters = new Map<PlatformId, PlatformAdapter>([
  ["threads", threadsAdapter],
  ["x", xAdapter],
]);

export function platform(id: PlatformId): PlatformAdapter {
  const a = adapters.get(id);
  if (!a) throw new Error(`unknown platform ${id}`);
  return a;
}

export function setPlatformForTests(id: PlatformId, adapter: PlatformAdapter | null): void {
  adapters.set(id, adapter ?? (id === "threads" ? threadsAdapter : xAdapter));
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
