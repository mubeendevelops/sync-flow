-- Up Migration

-- DB-backed refresh tokens: enables real revocation on logout and reuse detection on rotation
-- (stealing a token and racing the legitimate client is detectable and revocable), which a
-- stateless refresh JWT could not provide.
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Groups the rotation chain from a single login; reuse of any revoked token in a family
  -- revokes the whole family (theft detection).
  family_id  UUID NOT NULL,
  -- HMAC-SHA256(raw token, JWT_REFRESH_SECRET) -- never the raw token itself.
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves /auth/refresh and /auth/logout: look up the presented token by its hash.
CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON refresh_tokens (token_hash);
-- Serves reuse-detection revocation: revoke every token sharing a family in one statement.
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
-- Serves cleanup of expired rows.
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- Down Migration

DROP TABLE refresh_tokens;
