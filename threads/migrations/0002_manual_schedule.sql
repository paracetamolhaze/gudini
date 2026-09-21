ALTER TABLE drafts ADD COLUMN IF NOT EXISTS approved_by_user boolean NOT NULL DEFAULT false;
