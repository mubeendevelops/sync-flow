-- Up Migration

-- Version-history metadata on snapshots. Snapshots already ARE the version units
-- (one per ~100 ops / 30s / last-disconnect); these columns let the versions list
-- label meaningful checkpoints and attribute manual ones without changing how the
-- automatic snapshot cadence works.

-- What produced this snapshot:
--   'auto'          — the periodic snapshot policy (default; every existing + future
--                     policy-driven snapshot).
--   'restore_point' — the pre-restore capture of current state, so a restore is
--                     one-click undoable.
--   'post_restore'  — the state immediately after a restore's forward ops landed.
ALTER TABLE document_snapshots
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto',
  -- Human-readable checkpoint label, e.g. "Before restore to v42". NULL for plain
  -- auto-snapshots.
  ADD COLUMN label TEXT,
  -- Who triggered a manual/restore snapshot. NULL for automatic ones. SET NULL on
  -- user delete — same rule as document_operations.user_id: keep the history, drop
  -- only the attribution.
  ADD COLUMN created_by UUID REFERENCES users (id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE document_snapshots
  DROP COLUMN created_by,
  DROP COLUMN label,
  DROP COLUMN kind;
