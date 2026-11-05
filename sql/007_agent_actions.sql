-- Additive migration: no existing tables or records are removed.
CREATE TABLE IF NOT EXISTS agent_action_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action_key text NOT NULL,
 kind text CHECK(kind IN ('development','finances')),
 before_payload jsonb,
 after_revision bigint,
 result jsonb NOT NULL,
 changed boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'applied' CHECK(state IN ('applied','undone')),
 created_at timestamptz NOT NULL DEFAULT now(),
 undone_at timestamptz,
 UNIQUE(user_id,action_key)
);
CREATE INDEX IF NOT EXISTS agent_action_log_user_recent ON agent_action_log(user_id,created_at DESC);
