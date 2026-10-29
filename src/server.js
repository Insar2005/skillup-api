import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';

const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
}) : null;
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
const DOC_KINDS = new Set(['development', 'finances', 'progress', 'preferences']);
const sqlDir = fileURLToPath(new URL('../sql/', import.meta.url));
let ready = false;

async function migrate() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7401921)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const filename of (await readdir(sqlDir)).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(path.join(sqlDir, filename), 'utf8'));
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log('Applied migration:', filename);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(7401921)'); } finally { client.release(); }
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(body));
}
// Security diagnostic codes only. Never log initData, user fields, hashes or secrets.
function rejectTelegram(reason, signaturePresent = false) {
  if (process.env.AUTH_DIAGNOSTICS === 'true') {
    console.warn(`[Telegram Auth] rejected=${reason} signature_present=${signaturePresent}`);
  }
  return null;
}
function validateTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return rejectTelegram('bot_token_missing');
  if (typeof initData !== 'string' || !initData) return rejectTelegram('init_data_missing');
  if (initData.length > 16384) return rejectTelegram('init_data_too_large');
  const params = new URLSearchParams(initData);
  const hasSignature = params.has('signature');
  const hash = params.get('hash');
  const authRaw = params.get('auth_date');
  const authDate = authRaw && /^\d+$/.test(authRaw) ? Number(authRaw) : NaN;
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) return rejectTelegram('hash_missing_or_invalid', hasSignature);
  if (!Number.isSafeInteger(authDate)) return rejectTelegram('auth_date_invalid', hasSignature);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds < -60) return rejectTelegram('auth_date_in_future', hasSignature);
  if (ageSeconds > 86400) return rejectTelegram('auth_date_expired', hasSignature);
  const unique = new Set();
  for (const [key] of params) {
    if (unique.has(key)) return rejectTelegram('duplicate_parameter', hasSignature);
    unique.add(key);
  }
  // Bot-token HMAC validation: exclude only `hash`. The `signature` field,
  // if supplied, is part of the signed payload. For Ed25519 third-party
  // verification (not used here), both hash and signature are excluded.
  const dataCheckString = [...params.entries()].filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calculated)) {
    return rejectTelegram('hash_mismatch', hasSignature);
  }
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0)
      return rejectTelegram('signed_user_invalid_or_missing', hasSignature);
    return user;
  } catch { return rejectTelegram('signed_user_json_invalid', hasSignature); }
}

async function authenticatedUser(req) {
  const telegramUser = validateTelegram(req.headers['x-telegram-init-data']);
  if (!telegramUser) return null;
  const result = await pool.query(`INSERT INTO users (telegram_id, first_name, last_name, username, language_code)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_id)
    DO UPDATE SET first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
      username=EXCLUDED.username, language_code=EXCLUDED.language_code, updated_at=now()
    RETURNING id, telegram_id, first_name, username, created_at`,
    [telegramUser.id, telegramUser.first_name ?? null, telegramUser.last_name ?? null,
     telegramUser.username ?? null, telegramUser.language_code ?? null]);
  return result.rows[0];
}
async function readJsonBody(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) {
    size+=chunk.length;
    if (size > 2_000_000) {const error = new Error('Payload too large'); error.status=413; throw error;}
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {const error=new Error('Invalid JSON'); error.status=400; throw error;}
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {};
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'OPTIONS') {
      if (!Object.keys(cors).length) return json(res, 403, {error:'Origin not allowed'});
      res.writeHead(204, {...cors, 'access-control-allow-methods':'GET, PUT, OPTIONS', 'access-control-allow-headers':'X-Telegram-Init-Data, Content-Type', 'access-control-max-age':'600'});
      res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/') return json(res, 200, {service:'skillup-api', version:'0.2.1-authfix', status:ready ? 'ready' : 'starting'}, cors);
    if (req.method === 'GET' && pathname === '/health') {
      if (!ready) return json(res, 503, {status:'unavailable'}, cors);
      try { await pool.query('SELECT 1'); return json(res, 200, {status:'ok', database:'connected'}, cors); }
      catch { return json(res, 503, {status:'unavailable', database:'disconnected'}, cors); }
    }
    if (pathname === '/api/v1/me' || pathname.startsWith('/api/v1/documents/')) {
      if (!ready || !process.env.TELEGRAM_BOT_TOKEN) return json(res, 503, {error:'Service not configured'}, cors);
      const user = await authenticatedUser(req);
      if (!user) return json(res, 401, {error:'Valid Telegram Mini App authorization required'}, cors);
      if (pathname === '/api/v1/me' && req.method === 'GET') return json(res, 200, {user}, cors);
      const match = /^\/api\/v1\/documents\/([a-z]+)$/.exec(pathname);
      if (!match || !DOC_KINDS.has(match[1])) return json(res, 404, {error:'Not found'}, cors);
      const kind=match[1];
      if (req.method === 'GET') {
        const result=await pool.query('SELECT payload, revision, updated_at FROM user_documents WHERE user_id=$1 AND kind=$2', [user.id,kind]);
        return json(res, 200, {document:result.rows[0] || null}, cors);
      }
      if (req.method === 'PUT') {
        const body=await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) ||
            !(body.revision === null || (Number.isSafeInteger(body.revision) && body.revision > 0)))
          return json(res, 400, {error:'Expected {payload:object, revision:number|null}'}, cors);
        const client=await pool.connect();
        try {
          await client.query('BEGIN');
          const existing=await client.query('SELECT revision FROM user_documents WHERE user_id=$1 AND kind=$2 FOR UPDATE', [user.id,kind]);
          if ((!existing.rowCount && body.revision !== null) ||
              (existing.rowCount && Number(existing.rows[0].revision) !== body.revision)) {
            await client.query('ROLLBACK');
            return json(res, 409, {error:'Document revision conflict'}, cors);
          }
          let result;
          if (existing.rowCount) result=await client.query('UPDATE user_documents SET payload=$3::jsonb, revision=revision+1, updated_at=now() WHERE user_id=$1 AND kind=$2 RETURNING revision,updated_at', [user.id,kind,JSON.stringify(body.payload)]);
          else result=await client.query('INSERT INTO user_documents(user_id,kind,payload) VALUES($1,$2,$3::jsonb) RETURNING revision,updated_at', [user.id,kind,JSON.stringify(body.payload)]);
          await client.query('COMMIT');
          return json(res, 200, {revision:Number(result.rows[0].revision),updated_at:result.rows[0].updated_at}, cors);
        } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
        finally{client.release();}
      }
    }
    return json(res, 404, {error:'Not found'}, cors);
  } catch (error) {
    console.error('Request failed:', error.message);
    return json(res, error.status || 500, {error: error.status ? error.message : 'Internal server error'}, typeof origin === 'string' && allowedOrigins.includes(origin) ? {'access-control-allow-origin':origin,'vary':'Origin'} : {});
  }
});
server.listen(port, '0.0.0.0', async () => {
  console.log(`SkillUp API listening on port ${port}`);
  try { await migrate(); ready = true; console.log('Database ready'); }
  catch (error) { console.error('Database initialization failed:', error.message); process.exitCode = 1; server.close(); }
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => {server.close(); await pool?.end(); process.exit(0);});
