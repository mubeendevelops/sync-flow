-- Up Migration

-- Public just means "any authenticated user gets viewer access" (see assertCanAccess) — not an
-- anonymous public link. Defaults false: sharing is opt-in per document.
ALTER TABLE documents ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE documents DROP COLUMN is_public;
