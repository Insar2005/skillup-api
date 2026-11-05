-- Reversible user-owned goal deletion. Existing development documents are untouched.
CREATE TABLE IF NOT EXISTS development_action_history (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_items jsonb NOT NULL,
  state text NOT NULL DEFAULT 'deleted' CHECK (state IN ('deleted','restored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz
);
CREATE INDEX IF NOT EXISTS development_action_history_recent ON development_action_history(user_id, created_at DESC) WHERE state='deleted';
CREATE TABLE IF NOT EXISTS development_delete_pending (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  items jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
