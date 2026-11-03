# SkillUp v29.3 / existing Railway API, version 0.3.0

This is an **in-place extension** of SkillUp API v0.2.1-authfix. Do NOT deploy as a separate API. Do NOT delete/reset PostgreSQL.

## Install

1. Back up your `skillup-api` GitHub repository branch and database.
2. Copy files from this package **into the existing `skillup-api` repository** (root: Dockerfile, `package.json`, `src/`, `sql/`, `tests/`). Keep Railway service and existing environment variables.
3. In Railway → `skillup-api` → Variables add `ANTHROPIC_API_KEY` from Anthropic Console; optionally `ANTHROPIC_MODEL=claude-sonnet-5`. Do not share or commit the key. `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` and `CORS_ORIGINS` remain as currently configured. `CORS_ORIGINS` should include the exact HTTPS frontend origin.
4. Deploy API **before** deploying updated frontend. SQL `002_ai_single_chat.sql` runs automatically at startup through the **existing** migration engine. It only creates `ai_messages` and indexes.
5. Verify `GET /` reports `version: 0.3.0-single-ai` and `/health` reports `database: connected`.
6. Update the separate frontend repository with the `SkillUp_v29_3_FRONTEND.zip` contents.

## Endpoints

- `GET /api/v1/ai/history` — last 100 messages for **the signed Telegram user**, chronological order.
- `POST /api/v1/ai/chat` — `{message:string, requestId: UUID, focusItemId?:string}`. Returns `{answer}`. All AI requests use `X-Telegram-Init-Data`; timezone can be sent via `X-SkillUp-Timezone`.
- `POST /api/v1/ai/import-legacy` — explicit `confirmed:true`, max 250 old messages; deduplicates by digest. **Not automatic**.
- The pre-existing `/api/v1/me` and `/api/v1/documents/...` are unchanged.

## Agent

- Uses the existing `user_documents.kind='development'` in PostgreSQL as the ONLY source of goals and completion history.
- Context and ownership are resolved from the **server authenticated user**, never from a caller-provided owner or client-provided history.
- Claude Messages API. Read-only tools `list_goals`, `get_progress_report` (7/30/90 days). No tools that create or edit plans. Suggestions are text drafts only.
- Does not give full lessons, invent source links, or mix in personal finances.
- Server limits: 12 actual prompts per 15 minutes, 50 per day per user; at most 3 provider tool rounds, max 950 output tokens each round. Last 18 messages sent to model. Provider timeout 45 seconds.
- A model failure leaves database chat unchanged; network retry uses request UUID for idempotent save.
- Prior v29 local notes remain in `localStorage` and backups. Old chats can be copied into this one history only after user confirmation.

## Test locally

```bash
node --check src/server.js
node --check src/ai.js
node --check src/ai-routes.js
node tests/auth.test.mjs
node --test tests/ai.test.mjs tests/ai-routes.test.mjs
```

**What is not yet implemented:** automatic creation/editing of goals by the model (needs proposal/review/apply workflow), cloud note editor, full progress snapshots, external web search, real subscriptions and push reminders. Live Anthropic request, production migration and iOS tests must be verified after deployment.
