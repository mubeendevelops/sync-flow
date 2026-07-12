-- Up Migration

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves login/signup: look up a user by email; also enforces one account per email.
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Down Migration

DROP TABLE users;
