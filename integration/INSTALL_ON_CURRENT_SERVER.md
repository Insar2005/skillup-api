# SkillUp v29.12 — сервер: добавить OIDC, не перезаписывая текущий API

**ВАЖНО:** файл `server-v295-reference.js` — справочный вариант на основе старого `server.js` v29.5. Не заменяйте им текущий `src/server.js`! В репозитории SkillUp после v29.9–v29.11.1 могли появиться другие маршруты и инструменты. Сравните изменения по `server-integration.diff`, затем перенесите небольшие блоки вручную.

1. Добавьте в `src/server.js` импорт:

```js
import {handlePwaAuthRoute,pwaAuthenticatedUser,enforcePwaCsrf} from './pwa-auth.js';
```

2. В `authenticatedUser(req)` после вызова `validateTelegram(...)` замените ветку отсутствия подписанного пользователя на чтение PWA-сессии:

```js
if (!telegramUser) return pwaAuthenticatedUser(req,pool);
```

3. После обработки `OPTIONS`, но **до** общего защищённого `/api/v1`-роутинга, добавьте:

```js
if (pathname.startsWith('/api/v1/auth/')) {
  if (!ready) return json(res,503,{error:'Not ready'},cors);
  if (await handlePwaAuthRoute({req,res,pathname,pool})) return;
}
```

4. В начале **каждого** защищённого маршрута (AI, финансы, документы и т.д.) после получения `user=await authenticatedUser(req)`, при cookie-сессии и изменяющих HTTP-методах обязательно проверьте `Origin`:

```js
const signedMiniApp = Boolean(validateTelegram(req.headers['x-telegram-init-data']));
const user = await authenticatedUser(req);
if (!user) return json(res,401,{error:'Sign in with Telegram required'},cors);
if (!signedMiniApp && !enforcePwaCsrf(req,res)) return;
```

Не добавляйте второй `const user`. Замените существующую секцию. Убедитесь, что **все** маршруты `/api/v1/ai/*`, финансов, документов, предпочтений и действий проходят эту проверку. Если в более новой версии `server.js` проверка стоит в middleware, внесите её туда.

5. Добавьте `src/pwa-auth.js` и `sql/008_pwa_oidc.sql` (не удаляйте предыдущие миграции).

6. Railway Variables для **API**:

```dotenv
PWA_PUBLIC_ORIGIN=https://upniskillchipushila-production.up.railway.app
TELEGRAM_OIDC_CLIENT_ID=<Client ID from @BotFather Login Widget>
TELEGRAM_OIDC_CLIENT_SECRET=<Client Secret from @BotFather Login Widget>
```

Третий параметр **не** равен `TELEGRAM_BOT_TOKEN`. Никогда не вставляйте секреты в GitHub или фронтенд. Для этого потока требуется RS256 — стандартный алгоритм подписи Telegram OIDC.

7. В **@BotFather → Bot Settings → Login Widget** зарегистрируйте обе разрешённые ссылки:

- `https://upniskillchipushila-production.up.railway.app`
- `https://upniskillchipushila-production.up.railway.app/api/v1/auth/callback`

8. Проверьте `GET /api/v1/auth/me`: без сессии — HTTP 401. После входа через Telegram OIDC — HTTP 200 с текущим Telegram ID.

**Безопасность:** OIDC с PKCE и одноразовым state, проверкой JWKS-подписи/issuer/audience/expiration, cookie `__Host-su_session` с `Secure; HttpOnly; SameSite=Lax`, привязкой к `users.telegram_id`. Внешняя авторизация не заменяет авторизацию Mini App через `initData`.

**Предварительные тесты:** `node --test tests/pwa-auth.test.mjs tests/pwa-flow.test.mjs` (тестовая схема не обращается к рабочей БД). Живой Telegram OAuth и Railway нужно протестировать после настройки BotFather.
