-- Real OAuth: registered clients, hashed access/refresh tokens, and a scope on pending codes.
-- Existing connectors keep working: AUTH_TOKEN is still accepted as a bearer token.
ALTER TABLE oauth_codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'mcp';

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  CONSTRAINT oauth_clients_redirect_uris_json CHECK (json_valid(redirect_uris))
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  family_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  CONSTRAINT oauth_tokens_kind CHECK (kind IN ('access','refresh'))
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_expires ON oauth_tokens(expires_at);
