-- v29.5: private, expiring drafts. Raw photo/PDF bytes are never stored in PostgreSQL.
CREATE TABLE IF NOT EXISTS ai_receipt_drafts (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_receipt_drafts_user_pending_idx
  ON ai_receipt_drafts(user_id,created_at DESC) WHERE status='pending';

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency text NOT NULL DEFAULT 'RUB';
