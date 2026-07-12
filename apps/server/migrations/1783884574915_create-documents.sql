-- Up Migration

CREATE TABLE documents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL,
  -- RESTRICT (not CASCADE): deleting a user must never silently delete a document that
  -- other collaborators still have access to. The owner must transfer ownership or delete
  -- the document explicitly before their account can be removed.
  owner_id   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves "list documents I own" (GET /documents), excluding soft-deleted docs.
CREATE INDEX documents_owner_id_idx ON documents (owner_id) WHERE deleted_at IS NULL;

-- Down Migration

DROP TABLE documents;
