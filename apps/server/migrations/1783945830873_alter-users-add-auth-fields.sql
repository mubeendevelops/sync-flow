-- Up Migration

-- OAuth-ready: password_hash becomes nullable (OAuth-only users will have none), guarded by a
-- check constraint so 'local' accounts still can't be created without one.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN presence_color TEXT;
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local';

-- Backfill existing rows (seed data) before tightening to NOT NULL.
UPDATE users SET username = split_part(email, '@', 1), presence_color = '#3182CE'
WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ALTER COLUMN presence_color SET NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_local_requires_password_hash
  CHECK (auth_provider <> 'local' OR password_hash IS NOT NULL);

-- Serves signup: enforce one account per username, same pattern as users_email_key.
CREATE UNIQUE INDEX users_username_key ON users (username);

-- Down Migration

DROP INDEX users_username_key;
ALTER TABLE users DROP CONSTRAINT users_local_requires_password_hash;
ALTER TABLE users DROP COLUMN auth_provider;
ALTER TABLE users DROP COLUMN presence_color;
ALTER TABLE users DROP COLUMN username;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
