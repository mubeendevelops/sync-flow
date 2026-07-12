-- Up Migration

-- Only collaborators, never the owner: ownership lives on documents.owner_id so "owner
-- cannot be removed" is true by construction rather than enforced by app-level checks.
CREATE TYPE document_role AS ENUM ('editor', 'viewer');

CREATE TABLE document_members (
  document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        document_role NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- The PK (document_id, user_id) above already serves both:
--   - "get all members of a document" (GET /documents/:id)
--   - "does user X have role >= Y on document Z" (assertCanAccess)
-- since document_id is the leading column.

-- Serves "list documents I'm a member of" (GET /documents) — the reverse direction from
-- the PK, which leads with document_id and can't serve a lookup by user_id alone.
CREATE INDEX document_members_user_id_idx ON document_members (user_id);

-- Down Migration

DROP TABLE document_members;
DROP TYPE document_role;
