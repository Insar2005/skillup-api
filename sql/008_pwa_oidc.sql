-- SkillUp PWA OIDC flow and server-side sessions. No existing user data is changed.
CREATE TABLE IF NOT EXISTS pwa_auth_flows (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS pwa_sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pwa_sessions_user_id_idx ON pwa_sessions(user_id);
CREATE INDEX IF NOT EXISTS pwa_sessions_expires_at_idx ON pwa_sessions(expires_at);
