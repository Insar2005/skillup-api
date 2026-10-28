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
function validateTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData || initData.length > 16384) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f\d]{64}$/i.test(hash) || !Number.isSafeInteger(authDate)) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds < -60 || ageSeconds > 86400) return null;
  const unique = new Set();
  for (const [key] of params) { if (unique.has(key)) return null; unique.add(key); }
  const dataCheckString = [...params.entries()].filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calculated)) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return user;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {};
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'OPTIONS') {
      if (!Object.keys(cors).length) return json(res, 403, {error:'Origin not allowed'});
      res.writeHead(204, {...cors, 'access-control-allow-methods':'GET, OPTIONS', 'access-control-allow-headers':'X-Telegram-Init-Data, Content-Type', 'access-control-max-age':'600'});
      res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/') return json(res, 200, {service:'skillup-api', version:'0.1.0', status:ready ? 'ready' : 'starting'}, cors);
    if (req.method === 'GET' && pathname === '/health') {
      if (!ready) return json(res, 503, {status:'unavailable'}, cors);
      try { await pool.query('SELECT 1'); return json(res, 200, {status:'ok', database:'connected'}, cors); }
      catch { return json(res, 503, {status:'unavailable', database:'disconnected'}, cors); }
    }
    if (req.method === 'GET' && pathname === '/api/v1/me') {
      if (!ready || !process.env.TELEGRAM_BOT_TOKEN) return json(res, 503, {error:'Service not configured'}, cors);
      const user = validateTelegram(req.headers['x-telegram-init-data']);
      if (!user) return json(res, 401, {error:'Valid Telegram Mini App authorization required'}, cors);
      const result = await pool.query(`INSERT INTO users (telegram_id, first_name, last_name, username, language_code)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telegram_id)
        DO UPDATE SET first_name = EXCLUDED.first_name, last_name=EXCLUDED.last_name,
          username=EXCLUDED.username, language_code=EXCLUDED.language_code, updated_at=now()
        RETURNING id, telegram_id, first_name, username, created_at`,
        [user.id, user.first_name ?? null, user.last_name ?? null, user.username ?? null, user.language_code ?? null]);
      return json(res, 200, {user:result.rows[0]}, cors);
    }
    return json(res, 404, {error:'Not found'}, cors);
  } catch (error) {
    console.error('Request failed:', error.message);
    return json(res, 500, {error:'Internal server error'});
  }
});
server.listen(port, '0.0.0.0', async () => {
  console.log(`SkillUp API listening on port ${port}`);
  try { await migrate(); ready = true; console.log('Database ready'); }
  catch (error) { console.error('Database initialization failed:', error.message); process.exitCode = 1; server.close(); }
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => {server.close(); await pool?.end(); process.exit(0);});
