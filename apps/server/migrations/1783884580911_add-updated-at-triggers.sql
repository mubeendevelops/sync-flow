-- Up Migration

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- document_operations and document_snapshots are append-only and have no updated_at column,
-- so they get no trigger. Only tables with mutable rows need one.

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON document_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER set_updated_at ON document_members;
DROP TRIGGER set_updated_at ON documents;
DROP TRIGGER set_updated_at ON users;
DROP FUNCTION set_updated_at();
