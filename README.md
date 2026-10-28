# SkillUp API — Railway starter (v25 foundation)

Сервис Node.js, созданный отдельно от Nginx-фронтенда SkillUp v24.

## Публикация через Railway

1. Распакуйте архив в **отдельный GitHub-репозиторий `skillup-api`** (в корень, без дополнительной папки).
2. В Railway у уже созданного пустого сервиса `skillup-api` откройте **Settings → Source → Connect Repo**, выберите `skillup-api`.
3. В **Variables** убедитесь, что `DATABASE_URL` задан как **Reference на переменную Postgres.DATABASE_URL**. Нужен приватный адрес внутри проекта Railway, не публичный URL.
4. Запустите Deploy. Railway соберёт проект по `Dockerfile`; Node.js слушает порт, заданный Railway через `PORT` (по умолчанию 3000).
5. В **Settings → Networking → Public Networking → Generate Domain** получите HTTPS-адрес API.
6. Откройте `https://<ваш-api-домен>/health`. Ожидаемый результат: `{"status":"ok","database":"connected"}`.
7. Для следующего шага (авторизация в Telegram) укажите **TELEGRAM_BOT_TOKEN** в Variables сервиса API (не во фронтенде и не в GitHub). Укажите `CORS_ORIGINS=https://upniskillchipushila-production.up.railway.app` для запросов из браузера.

## Что реализовано

- `GET /` — версия сервиса.
- `GET /health` — проверка подключения PostgreSQL.
- Автоматическое применение SQL-миграции `001_initial.sql` (под блокировкой, чтобы два экземпляра не применяли одновременно).
- Начальные таблицы `users`, `user_documents`, `completion_events`, `finance_transactions`.
- `GET /api/v1/me` — проверка подписи `Telegram.WebApp.initData` с серверным BOT_TOKEN и привязка пользователя; заголовок `X-Telegram-Init-Data`. Без токена / валидного initData возвращает отказ.

**Не реализовано:** перенос localStorage, работающий CRUD финансов/развития, реальный ИИ, подписки и напоминания. Старый HTML фронтенд пока НЕ подключён к API. Таблицы — стартовая схема, не окончательная модель предметной области.

## Безопасность

Никогда не помещайте `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` или другие секреты в HTML, GitHub и сообщения чата. Приложение не доверяет Telegram `initDataUnsafe`: подпись проверяется на сервере. Для регистрации пользователей недостаточно одного публичного `/health` — вызов `/api/v1/me` должен выполняться из Telegram Mini App с действительными `initData`.
