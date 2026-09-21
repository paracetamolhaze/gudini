-- Two platforms (Threads + X) share one content pipeline; plus Hyperliquid trades and market movers.
-- Everything that used to say "threads_post_id" is a platform post id now, keyed together with `platform`.

-- ---------------------------------------------------------------- accounts
ALTER TABLE accounts RENAME COLUMN threads_user_id TO platform_user_id;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_threads_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_platform_user_unique ON accounts (platform, platform_user_id);

-- ---------------------------------------------------------------- publications: one row per (draft, platform)
ALTER TABLE publications RENAME COLUMN threads_post_id TO platform_post_id;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_threads_post_id_key;
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_draft_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS publications_platform_post_unique ON publications (platform, platform_post_id);
CREATE UNIQUE INDEX IF NOT EXISTS publications_draft_platform_unique ON publications (draft_id, platform) WHERE draft_id IS NOT NULL;

ALTER TABLE publication_attempts RENAME COLUMN threads_post_id TO platform_post_id;
ALTER TABLE publication_attempts ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';

ALTER TABLE insight_snapshots RENAME COLUMN threads_post_id TO platform_post_id;
ALTER TABLE insight_snapshots ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';

-- ---------------------------------------------------------------- drafts: targets, X variant, kind, own facts
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'NEWS';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT '{threads}';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS text_x text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS trade_id uuid;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS facts_json jsonb;
UPDATE drafts SET kind = 'TOPIC' WHERE candidate_id IS NULL AND kind = 'NEWS';
CREATE INDEX IF NOT EXISTS drafts_kind_idx ON drafts (kind, created_at DESC);

-- ---------------------------------------------------------------- interactions / conversations / discovery
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';
-- api = sent through the platform API; manual = the owner posts it by hand (X forbids cold API replies);
-- quote = goes out as a quote post.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'api';
DROP INDEX IF EXISTS interactions_target_unique;
DROP INDEX IF EXISTS interactions_public_unique;
CREATE UNIQUE INDEX interactions_target_unique ON interactions (platform, type, target_reply_id) WHERE target_reply_id IS NOT NULL;
CREATE UNIQUE INDEX interactions_public_unique ON interactions (platform, type, target_post_id) WHERE type = 'PUBLIC_POST_REPLY';

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';
ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS conversation_messages_message_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_platform_msg_unique ON conversation_messages (platform, message_id);

ALTER TABLE discovered_posts RENAME COLUMN threads_post_id TO platform_post_id;
ALTER TABLE discovered_posts ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'threads';
ALTER TABLE discovered_posts DROP CONSTRAINT IF EXISTS discovered_posts_threads_post_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS discovered_posts_platform_post_unique ON discovered_posts (platform, platform_post_id);

-- Generated images (trade cards) have no source URL to download from.
ALTER TABLE media_assets ALTER COLUMN original_url SET DEFAULT '';

-- ---------------------------------------------------------------- paid API usage (X is pay-per-use)
CREATE TABLE IF NOT EXISTS platform_usage (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  platform        text NOT NULL,
  operation       text NOT NULL,
  units           int  NOT NULL DEFAULT 1,
  estimated_cost  numeric(12,6) NOT NULL DEFAULT 0,
  meta            jsonb
);
CREATE INDEX IF NOT EXISTS platform_usage_at_idx ON platform_usage (platform, at DESC);

-- ---------------------------------------------------------------- Hyperliquid
CREATE TABLE IF NOT EXISTS hl_fills (
  tid             bigint PRIMARY KEY,
  wallet          text NOT NULL,
  coin            text NOT NULL,
  side            text NOT NULL,
  dir             text NOT NULL DEFAULT '',
  px              numeric NOT NULL,
  sz              numeric NOT NULL,
  start_position  numeric NOT NULL DEFAULT 0,
  closed_pnl      numeric NOT NULL DEFAULT 0,
  fee             numeric NOT NULL DEFAULT 0,
  fee_token       text,
  hash            text,
  oid             bigint,
  crossed         boolean,
  time            timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hl_fills_wallet_coin_time_idx ON hl_fills (wallet, coin, time);

CREATE TABLE IF NOT EXISTS hl_trades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet          text NOT NULL,
  coin            text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('LONG','SHORT')),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz,
  entry_px        numeric NOT NULL,
  exit_px         numeric,
  max_size        numeric NOT NULL,
  entry_notional  numeric NOT NULL,
  closed_pnl      numeric NOT NULL DEFAULT 0,
  fees            numeric NOT NULL DEFAULT 0,
  net_pnl         numeric NOT NULL DEFAULT 0,
  leverage        numeric,
  roe_pct         numeric,
  move_pct        numeric,
  fills_count     int NOT NULL DEFAULT 0,
  first_tid       bigint NOT NULL,
  last_tid        bigint,
  last_hash       text,
  post_status     text NOT NULL DEFAULT 'NONE',
  skip_reason     text,
  note            text,
  draft_id        uuid,
  card_asset_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, coin, first_tid)
);
CREATE INDEX IF NOT EXISTS hl_trades_closed_idx ON hl_trades (wallet, closed_at DESC);

-- Leverage is only visible while a position is open, so it is remembered per coin as it is seen.
CREATE TABLE IF NOT EXISTS hl_leverage (
  wallet      text NOT NULL,
  coin        text NOT NULL,
  leverage    numeric NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, coin)
);

-- ---------------------------------------------------------------- market movers
CREATE TABLE IF NOT EXISTS market_moves (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          text NOT NULL,
  name            text NOT NULL DEFAULT '',
  coingecko_id    text,
  direction       text NOT NULL CHECK (direction IN ('UP','DOWN')),
  period          text NOT NULL DEFAULT '24h',
  change_pct      numeric NOT NULL,
  price           numeric NOT NULL,
  market_cap      numeric,
  volume_24h      numeric,
  rank            int,
  day             date NOT NULL,
  status          text NOT NULL DEFAULT 'FOUND',
  reason          text,
  draft_id        uuid,
  data_json       jsonb,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, direction, day)
);
CREATE INDEX IF NOT EXISTS market_moves_detected_idx ON market_moves (detected_at DESC);

-- ---------------------------------------------------------------- prompts speak in the first person now
-- Untouched built-in defaults are dropped so the new built-ins get seeded on first use; any version the
-- owner wrote or activated by hand stays exactly as it is.
DELETE FROM prompt_versions p
WHERE p.name IN ('crypto_writer', 'reply_writer', 'reply_decision') AND p.version = 1 AND p.note = 'built-in default'
  AND NOT EXISTS (SELECT 1 FROM prompt_versions o WHERE o.name = p.name AND o.version > 1);
