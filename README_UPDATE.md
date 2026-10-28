# SkillUp API v0.2.0

Deploy this entire directory to the existing `skillup-api` GitHub repository, replacing existing files. Do not create a second Railway service.

- `GET /api/v1/documents/{development|finances|progress|preferences}` — returns `{document: null | {payload, revision, updated_at}}`.
- `PUT /api/v1/documents/{kind}` — body `{payload: {}, revision: null|number}`, optimistic locking via 409 conflict.
- Both require `X-Telegram-Init-Data` and valid `TELEGRAM_BOT_TOKEN`.
- `CORS_ORIGINS` must contain the exact frontend HTTPS origin.
- No schema migration needed; reuses `user_documents`.
- No public unauthenticated storage endpoints.
