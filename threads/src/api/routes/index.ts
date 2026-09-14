import type { FastifyInstance } from "fastify";
import { registerSettingsRoutes } from "./settings.js";
import { registerStatusRoutes } from "./status.js";
import { registerLogRoutes } from "./logs.js";

/** All JSON API routes live under `${prefix}/api`. Modules are added per phase. */
export async function registerApiRoutes(app: FastifyInstance, api: string): Promise<void> {
  registerStatusRoutes(app, api);
  registerSettingsRoutes(app, api);
  registerLogRoutes(app, api);
}
