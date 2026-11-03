-- SkillUp v29.3: a single server-owned conversation per Telegram user.
-- No changes to existing documents, transactions or local finance/development data.
CREATE TABLE IF NOT EXISTS ai_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 12000),
  request_id uuid,
  reply_to uuid,
  legacy_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_messages_request_unique ON ai_messages(user_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_messages_reply_unique ON ai_messages(user_id, reply_to) WHERE reply_to IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_messages_legacy_unique ON ai_messages(user_id, legacy_key) WHERE legacy_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_messages_user_recent ON ai_messages(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ai_messages_user_time ON ai_messages(user_id, created_at DESC, id DESC);
