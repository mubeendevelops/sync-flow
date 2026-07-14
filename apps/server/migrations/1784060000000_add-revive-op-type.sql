-- Up Migration

-- The `revive` op un-tombstones a character (undo of a delete). It persists like a
-- delete (targets an existing char id, carries the reviver's lamport_clock/replica_id
-- as its LWW visibility stamp; no after_id/value). Adding the enum value is all the
-- schema needs — row-mapping handles the rest.
ALTER TYPE document_op_type ADD VALUE IF NOT EXISTS 'revive';

-- Down Migration

-- Postgres can't drop an enum value in place, so rebuild the 2-value type. This fails
-- (intentionally) if any 'revive' rows exist — they can't be represented without it.
ALTER TABLE document_operations ALTER COLUMN op_type TYPE TEXT;
DROP TYPE document_op_type;
CREATE TYPE document_op_type AS ENUM ('insert', 'delete');
ALTER TABLE document_operations
  ALTER COLUMN op_type TYPE document_op_type USING op_type::document_op_type;
