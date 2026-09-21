import { threadsClient } from "../threads/index.js";
import { query } from "../db/pool.js";
import { loadSettings } from "../config/settings.js";
import { activePlatforms, type PlatformId } from "../platforms/index.js";
import { errorMessage, logger } from "../shared/logger.js";
import { audit } from "./audit.js";

/** Resolve the identity on every connected platform once and keep the accounts rows current. */
export async function syncAccounts(): Promise<Array<{ platform: PlatformId; username: string; userId: string }>> {
  const settings = await loadSettings();
  const out: Array<{ platform: PlatformId; username: string; userId: string }> = [];
  for (const adapter of activePlatforms(settings)) {
    try {
      const me = await adapter.me();
      const tokenExpiresAt = adapter.id === "threads" && threadsClient().tokenExpiresAt ? new Date(threadsClient().tokenExpiresAt!) : null;
      await query(
        `INSERT INTO accounts (platform, username, platform_user_id, timezone, language, profile_json, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (platform, platform_user_id) DO UPDATE SET username = EXCLUDED.username, profile_json = EXCLUDED.profile_json,
           token_expires_at = COALESCE(EXCLUDED.token_expires_at, accounts.token_expires_at), updated_at = now()`,
        [adapter.id, me.username, me.id, settings.schedule.timezone, adapter.id === "x" ? settings.platforms.x.language : "ru", JSON.stringify(me), tokenExpiresAt],
      );
      out.push({ platform: adapter.id, username: me.username, userId: me.id });
    } catch (err) {
      logger().warn({ platform: adapter.id, err: errorMessage(err) }, "account sync failed");
    }
  }
  return out;
}

/** Kept for callers that only care about Threads. */
export async function syncAccount(): Promise<{ username: string; userId: string } | null> {
  const all = await syncAccounts();
  return all.find((a) => a.platform === "threads") ?? null;
}

export async function recordTokenRefresh(expiresAt: number | undefined): Promise<void> {
  if (expiresAt) await query(`UPDATE accounts SET token_expires_at = $1, updated_at = now() WHERE platform = 'threads'`, [new Date(expiresAt)]);
  await audit("TOKEN_REFRESHED", "Долгоживущий токен Threads обновлён", {}, { expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
}
