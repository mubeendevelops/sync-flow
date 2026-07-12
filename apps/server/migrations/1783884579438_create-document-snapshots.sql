-- Up Migration

CREATE TABLE document_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- The document_operations.seq watermark this snapshot covers through: current state can
  -- be rebuilt as fromSnapshot(state) + replay(ops WHERE seq > this value). Not a formal FK
  -- to document_operations — those rows may be pruned by retention while this snapshot
  -- (and the state it captures) remains valid.
  seq         BIGINT NOT NULL,
  -- Full materialized RGA state (chars, tombstones, clocks) per packages/crdt's snapshot shape.
  state       JSONB NOT NULL,
  -- Denormalized materialized text, kept alongside `state` so dashboard previews/search don't
  -- need to deserialize and replay the CRDT just to show a snippet.
  plain_text  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves "get the latest snapshot for a document" (ORDER BY seq DESC LIMIT 1 — a btree index
-- is scanned backwards just as cheaply) and enforces one snapshot per watermark per document.
CREATE UNIQUE INDEX document_snapshots_document_id_seq_idx ON document_snapshots (document_id, seq);

-- Down Migration

DROP TABLE document_snapshots;
