import { threadsClient } from "../threads/index.js";
import { query } from "../db/pool.js";
import { loadSettings } from "../config/settings.js";
import { audit } from "./audit.js";

/** Resolve /me once and keep the accounts row current (username, id, token expiry). */
export async function syncAccount(): Promise<{ username: string; userId: string } | null> {
  const client = threadsClient();
  if (!client.hasToken) return null;
  const me = await client.me();
  const settings = await loadSettings();
  await query(
    `INSERT INTO accounts (platform, username, threads_user_id, timezone, language, profile_json, token_expires_at)
     VALUES ('threads', $1, $2, $3, 'ru', $4::jsonb, $5)
     ON CONFLICT (threads_user_id) DO UPDATE SET username = EXCLUDED.username, profile_json = EXCLUDED.profile_json,
       token_expires_at = COALESCE(EXCLUDED.token_expires_at, accounts.token_expires_at), updated_at = now()`,
    [me.username, me.id, settings.schedule.timezone, JSON.stringify(me), client.tokenExpiresAt ? new Date(client.tokenExpiresAt) : null],
  );
  return { username: me.username, userId: me.id };
}

export async function recordTokenRefresh(expiresAt: number | undefined): Promise<void> {
  if (expiresAt) await query(`UPDATE accounts SET token_expires_at = $1, updated_at = now()`, [new Date(expiresAt)]);
  await audit("TOKEN_REFRESHED", "Долгоживущий токен Threads обновлён", {}, { expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
}
