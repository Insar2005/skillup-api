-- Retain a reversible record of individual finance operations.
-- No changes to existing user_documents, and no legacy data is deleted.
CREATE TABLE IF NOT EXISTS finance_action_history (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  entry jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','undone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  restored_at timestamptz,
  PRIMARY KEY (user_id, external_id)
);
CREATE INDEX IF NOT EXISTS finance_action_history_last_undone
  ON finance_action_history(user_id, undone_at DESC)
  WHERE state='undone';
