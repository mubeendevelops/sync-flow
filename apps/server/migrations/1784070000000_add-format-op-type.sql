-- Up Migration

-- The `format` op sets/clears one formatting attribute (inline mark or block-level attribute)
-- on a char — an LWW register on (char_id, format_key), same persistence shape as delete/
-- revive (targets an existing char id, carries the setter's lamport_clock/replica_id as its
-- LWW stamp) plus two extra columns: the attribute name and its new value. `value` is reused
-- from the insert column (never populated together, since insert/delete/revive/format are
-- mutually exclusive op types) and holds the format value serialized to text — row-mapping
-- handles boolean<->text conversion using `format_key` to know which keys are boolean-valued.
ALTER TYPE document_op_type ADD VALUE IF NOT EXISTS 'format';

ALTER TABLE document_operations ADD COLUMN format_key TEXT;

-- Down Migration

ALTER TABLE document_operations DROP COLUMN IF EXISTS format_key;

-- Postgres can't drop an enum value in place, so rebuild the type. This fails (intentionally)
-- if any 'format' rows exist — they can't be represented without it.
ALTER TABLE document_operations ALTER COLUMN op_type TYPE TEXT;
DROP TYPE document_op_type;
CREATE TYPE document_op_type AS ENUM ('insert', 'delete', 'revive');
ALTER TABLE document_operations
  ALTER COLUMN op_type TYPE document_op_type USING op_type::document_op_type;
