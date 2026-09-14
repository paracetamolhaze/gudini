import type { FastifyInstance } from "fastify";
import { registerSettingsRoutes } from "./settings.js";
import { registerStatusRoutes } from "./status.js";
import { registerLogRoutes } from "./logs.js";
import { registerSourceRoutes } from "./sources.js";
import { registerCandidateRoutes } from "./candidates.js";
import { registerDraftRoutes } from "./drafts.js";
import { registerVoiceRoutes } from "./voice.js";
import { registerMediaRoutes } from "./media.js";
import { registerPublishingRoutes } from "./publishing.js";

/** All JSON API routes live under `${prefix}/api`. Modules are added per phase. */
export async function registerApiRoutes(app: FastifyInstance, api: string, prefix: string = api.replace(/\/api$/, "")): Promise<void> {
  registerStatusRoutes(app, api);
  registerSettingsRoutes(app, api);
  registerLogRoutes(app, api);
  registerSourceRoutes(app, api);
  registerCandidateRoutes(app, api);
  registerDraftRoutes(app, api);
  registerVoiceRoutes(app, api);
  registerMediaRoutes(app, prefix, api);
  registerPublishingRoutes(app, api);
}
