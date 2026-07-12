-- Up Migration

CREATE TYPE document_op_type AS ENUM ('insert', 'delete');

CREATE TABLE document_operations (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deleting a document should delete its op log with it — nothing else depends on it.
  document_id    UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- SET NULL, never CASCADE: hard-deleting a user must not delete the operation rows
  -- themselves, which would corrupt CRDT replay for every document that user ever touched.
  -- We only lose the attribution, not the history.
  user_id        UUID REFERENCES users (id) ON DELETE SET NULL,
  -- Server-assigned monotonic sequence, distinct from the CRDT's own lamport_clock. This is
  -- what the sync protocol ("ops since version N") and snapshot watermarks key off. A plain
  -- BIGSERIAL gives atomic, gap-tolerant, concurrency-safe assignment via Postgres's own
  -- sequence machinery, with no application-level locking or retry logic required.
  seq            BIGSERIAL NOT NULL UNIQUE,
  op_type        document_op_type NOT NULL,
  -- RGA character id, encoded "<lamportClock>@<replicaId>".
  char_id        TEXT NOT NULL,
  -- Anchor char id for inserts (the char this one was inserted after); null for deletes.
  after_id       TEXT,
  -- Single character payload; only present for inserts.
  value          TEXT,
  -- Originating browser tab, not the user (a user can have two tabs open on one document).
  replica_id     UUID NOT NULL,
  lamport_clock  BIGINT NOT NULL,
  op_version     SMALLINT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the sync/resume protocol ("give me all ops after seq N for this document") and the
-- paginated debug/audit op log endpoint. seq's own UNIQUE constraint above enforces that no
-- two operations ever receive the same version number.
CREATE INDEX document_operations_document_id_seq_idx ON document_operations (document_id, seq);

-- Down Migration

DROP TABLE document_operations;
DROP TYPE document_op_type;
