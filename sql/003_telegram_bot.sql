-- Durable update receipt, idempotent drafts/confirmation.
CREATE TABLE IF NOT EXISTS bot_updates (
 update_id bigint PRIMARY KEY,
 payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','working','done')),
 attempts integer NOT NULL DEFAULT 0,
 received_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz
);
CREATE INDEX IF NOT EXISTS bot_updates_pending ON bot_updates(received_at) WHERE status <> 'done';
CREATE TABLE IF NOT EXISTS bot_finance_drafts (
 id uuid PRIMARY KEY,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 chat_id bigint NOT NULL,
 direction text NOT NULL CHECK(direction IN ('income','expense')),
 amount bigint NOT NULL CHECK(amount > 0 AND amount < 1000000000000),
 category text,
 note text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
