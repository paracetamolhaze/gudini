-- Gudini Threads: initial schema. Applied by src/db/migrate.ts inside a transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         text NOT NULL DEFAULT 'threads',
  username         text NOT NULL,
  threads_user_id  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'active',
  timezone         text NOT NULL DEFAULT 'Europe/Moscow',
  language         text NOT NULL DEFAULT 'ru',
  token_expires_at timestamptz,
  profile_json     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('THREADS_PROFILE','THREADS_SEARCH','RSS','NEWS','MANUAL')),
  platform         text NOT NULL DEFAULT 'threads',
  username         text,
  name             text NOT NULL,
  url              text,
  language         text NOT NULL DEFAULT 'en',
  priority         int  NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  enabled          boolean NOT NULL DEFAULT true,
  trust_score      int  NOT NULL DEFAULT 60 CHECK (trust_score BETWEEN 0 AND 100),
  copy_mode        text NOT NULL DEFAULT 'FACTS_ONLY',
  translate_images boolean NOT NULL DEFAULT false,
  minimum_score    int,
  keywords         text[] NOT NULL DEFAULT '{}',
  poll_minutes     int  NOT NULL DEFAULT 15,
  last_checked_at  timestamptz,
  last_post_at     timestamptz,
  last_error       text,
  last_status      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_profile_unique ON sources (platform, lower(username)) WHERE type = 'THREADS_PROFILE';

CREATE TABLE IF NOT EXISTS source_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid REFERENCES sources(id) ON DELETE SET NULL,
  platform          text NOT NULL,
  platform_post_id  text NOT NULL,
  author_username   text NOT NULL DEFAULT '',
  text              text NOT NULL DEFAULT '',
  permalink         text,
  published_at      timestamptz,
  media_json        jsonb NOT NULL DEFAULT '[]',
  raw_json          jsonb,
  content_hash      text NOT NULL,
  semantic_hash     text,
  status            text NOT NULL DEFAULT 'NEW',
  duplicate_of      uuid REFERENCES source_posts(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_post_id)
);
CREATE INDEX IF NOT EXISTS source_posts_created_idx ON source_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS source_posts_hash_idx ON source_posts (content_hash);
CREATE INDEX IF NOT EXISTS source_posts_status_idx ON source_posts (status);

CREATE TABLE IF NOT EXISTS event_clusters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key        text,
  title            text NOT NULL DEFAULT '',
  source_post_ids  uuid[] NOT NULL DEFAULT '{}',
  candidate_id     uuid,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_candidates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id   uuid NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
  cluster_id       uuid REFERENCES event_clusters(id) ON DELETE SET NULL,
  topic            text,
  category         text,
  relevance_score  numeric(5,2),
  freshness_score  numeric(5,2),
  virality_score   numeric(5,2),
  trust_score      numeric(5,2),
  uniqueness_score numeric(5,2),
  risk_score       numeric(5,2),
  total_score      numeric(5,2),
  analysis_json    jsonb,
  facts_json       jsonb,
  status           text NOT NULL DEFAULT 'DISCOVERED',
  reject_reason    text,
  priority         text NOT NULL DEFAULT 'P2',
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_post_id)
);
CREATE INDEX IF NOT EXISTS candidates_status_idx ON content_candidates (status, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id     uuid REFERENCES content_candidates(id) ON DELETE SET NULL,
  type             text NOT NULL DEFAULT 'NEWS',
  text             text NOT NULL DEFAULT '',
  hook             text,
  body             text,
  source_summary   text,
  source_urls_json jsonb NOT NULL DEFAULT '[]',
  confidence       numeric(5,2),
  risk_score       numeric(5,2),
  status           text NOT NULL DEFAULT 'DRAFT',
  review_reason    text,
  scheduled_at     timestamptz,
  priority         text NOT NULL DEFAULT 'P2',
  prompt_version   text,
  model            text,
  validation_json  jsonb,
  variants_json    jsonb,
  image_asset_id   uuid,
  expires_at       timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS media_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id    uuid REFERENCES source_posts(id) ON DELETE SET NULL,
  draft_id          uuid REFERENCES drafts(id) ON DELETE SET NULL,
  original_url      text NOT NULL,
  local_path        text,
  media_type        text NOT NULL DEFAULT 'image',
  width             int,
  height            int,
  ocr_json          jsonb,
  translation_json  jsonb,
  translated_path   text,
  final_path        text,
  qa_json           jsonb,
  status            text NOT NULL DEFAULT 'PENDING',
  attempts          int NOT NULL DEFAULT 0,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publication_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  draft_id         uuid REFERENCES drafts(id) ON DELETE SET NULL,
  interaction_id   uuid,
  kind             text NOT NULL,
  container_id     text,
  threads_post_id  text,
  status           text NOT NULL DEFAULT 'STARTED',
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id         uuid UNIQUE REFERENCES drafts(id) ON DELETE SET NULL,
  candidate_id     uuid,
  source_post_id   uuid,
  media_asset_id   uuid,
  threads_post_id  text NOT NULL UNIQUE,
  permalink        text,
  published_text   text NOT NULL,
  published_at     timestamptz NOT NULL DEFAULT now(),
  prompt_version   text,
  model            text,
  dry_run          boolean NOT NULL DEFAULT false,
  meta_json        jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               text NOT NULL CHECK (type IN ('OWN_POST_REPLY','MENTION','PUBLIC_POST_REPLY','NESTED_REPLY')),
  target_post_id     text,
  target_reply_id    text,
  root_post_id       text,
  publication_id     uuid REFERENCES publications(id) ON DELETE SET NULL,
  target_username    text NOT NULL DEFAULT '',
  target_text        text NOT NULL DEFAULT '',
  target_permalink   text,
  target_published_at timestamptz,
  our_text           text,
  decision           text,
  reason             text,
  decision_json      jsonb,
  status             text NOT NULL DEFAULT 'PENDING',
  published_reply_id text,
  permalink          text,
  error              text,
  prompt_version     text,
  model              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS interactions_target_unique ON interactions (type, target_reply_id) WHERE target_reply_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS interactions_public_unique ON interactions (type, target_post_id) WHERE type = 'PUBLIC_POST_REPLY';
CREATE INDEX IF NOT EXISTS interactions_status_idx ON interactions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_post_id         text NOT NULL,
  message_id           text NOT NULL UNIQUE,
  parent_id            text,
  username             text NOT NULL DEFAULT '',
  text                 text NOT NULL DEFAULT '',
  is_ours              boolean NOT NULL DEFAULT false,
  media_json           jsonb NOT NULL DEFAULT '[]',
  platform_timestamp   timestamptz,
  raw_json             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_root_idx ON conversation_messages (root_post_id, platform_timestamp);

CREATE TABLE IF NOT EXISTS discovered_posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  threads_post_id  text NOT NULL UNIQUE,
  username         text NOT NULL DEFAULT '',
  text             text NOT NULL DEFAULT '',
  permalink        text,
  published_at     timestamptz,
  keyword          text,
  scores_json      jsonb,
  total_score      numeric(5,2),
  status           text NOT NULL DEFAULT 'FOUND',
  reason           text,
  interaction_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS style_examples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text        text NOT NULL,
  rating      int  NOT NULL DEFAULT 3 CHECK (rating BETWEEN 1 AND 5),
  source      text NOT NULL DEFAULT 'manual',
  enabled     boolean NOT NULL DEFAULT true,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  rating      text NOT NULL CHECK (rating IN ('LIKE','DISLIKE')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  version     int  NOT NULL,
  prompt      text NOT NULL,
  active      boolean NOT NULL DEFAULT false,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_active_unique ON prompt_versions (name) WHERE active;

CREATE TABLE IF NOT EXISTS jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL,
  job_id       text NOT NULL,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  payload      jsonb,
  result       jsonb,
  error        text,
  attempts     int NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (queue, job_id, attempts)
);
CREATE INDEX IF NOT EXISTS jobs_started_idx ON jobs (started_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  event           text NOT NULL,
  level           text NOT NULL DEFAULT 'info',
  message         text NOT NULL,
  details         jsonb,
  source_id       uuid,
  source_post_id  uuid,
  candidate_id    uuid,
  draft_id        uuid,
  interaction_id  uuid,
  publication_id  uuid,
  media_asset_id  uuid,
  job_id          text
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_logs (at DESC);
CREATE INDEX IF NOT EXISTS audit_candidate_idx ON audit_logs (candidate_id);
CREATE INDEX IF NOT EXISTS audit_draft_idx ON audit_logs (draft_id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  provider        text NOT NULL,
  model           text NOT NULL,
  operation       text NOT NULL,
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  estimated_cost  numeric(12,6),
  duration_ms     int,
  ok              boolean NOT NULL DEFAULT true,
  error           text,
  candidate_id    uuid,
  draft_id        uuid,
  interaction_id  uuid,
  media_asset_id  uuid
);
CREATE INDEX IF NOT EXISTS llm_calls_at_idx ON llm_calls (at DESC);

CREATE TABLE IF NOT EXISTS insight_snapshots (
  id               bigserial PRIMARY KEY,
  publication_id   uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  threads_post_id  text NOT NULL,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  views            int NOT NULL DEFAULT 0,
  likes            int NOT NULL DEFAULT 0,
  replies          int NOT NULL DEFAULT 0,
  reposts          int NOT NULL DEFAULT 0,
  quotes           int NOT NULL DEFAULT 0,
  shares           int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS insight_pub_idx ON insight_snapshots (publication_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS recommendations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL,
  title          text NOT NULL,
  body           text NOT NULL,
  evidence_json  jsonb,
  status         text NOT NULL DEFAULT 'PROPOSED',
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
