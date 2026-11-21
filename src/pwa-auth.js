/* SkillUp PWA OIDC login. This module is independent of Mini App initData auth.
 * Only Telegram's signed OIDC ID token can create a PWA session.
 * No Telegram user ID or user profile value from a browser request is trusted.
 * RS256 is the default signing algorithm configured in BotFather.
 */
import crypto from 'node:crypto';

const OIDC_ISSUER = 'https://oauth.telegram.org';
const AUTH_URL = `${OIDC_ISSUER}/auth`;
const TOKEN_URL = `${OIDC_ISSUER}/token`;
const JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks.json`;
const STATE_COOKIE = 'su_oidc_state';
const SESSION_COOKIE = '__Host-su_session';
const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('base64url');
const origin = () => (process.env.PWA_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const clientId = () => process.env.TELEGRAM_OIDC_CLIENT_ID || '';
const enabled = () => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin()) && Boolean(clientId() && process.env.TELEGRAM_OIDC_CLIENT_SECRET);
const callbackUri = () => `${origin()}/api/v1/auth/callback`;
const cookie = (name, value, age, extra = '') => `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax${extra}`;
const expireCookie = name => cookie(name, '', 0);
const getCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s).slice(0,2)).filter(a=>a.length===2).map(([k,v])=>{try{return [k,decodeURIComponent(v)]}catch{return [k,'']}}));
const redirect = (res, where, cookies = []) => {res.writeHead(302, {location:where, 'cache-control':'no-store',...(cookies.length?{'set-cookie':cookies}:{})});res.end();};
const json = (res,status,value,headers={}) => {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));};
const safeErr = (res,status,code) => json(res,status,{error:code});
const validOrigin = req => req.headers.origin === origin();
let keyCache=null, keyCacheUntil=0;
async function jwks() {
  if(keyCache && Date.now()<keyCacheUntil)return keyCache;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
  try {
    const response=await fetch(JWKS_URL,{signal:controller.signal});
    if(!response.ok)throw Error('JWKS unavailable');
    const data=await response.json();
    if(!Array.isArray(data.keys))throw Error('Invalid JWKS');
    keyCache=data.keys;keyCacheUntil=Date.now()+15*60_000;return keyCache;
  }finally{clearTimeout(timeout)}
}
function b64parse(value){return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}
export async function verifyTelegramIdToken(jwt, expectedNonce) {
  if(typeof jwt!=='string'||jwt.length>12000)throw Error('Invalid ID token');
  const pieces=jwt.split('.'); if(pieces.length!==3)throw Error('Invalid JWT');
  const header=b64parse(pieces[0]), claims=b64parse(pieces[1]);
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256)throw Error('Unsupported JWT signing algorithm');
  const jwk=(await jwks()).find(k=>k.kid===header.kid && k.kty==='RSA' && (!k.use||k.use==='sig'));
  if(!jwk)throw Error('Unknown signing key');
  const verified=crypto.verify('RSA-SHA256',Buffer.from(pieces[0]+'.'+pieces[1]),crypto.createPublicKey({key:jwk,format:'jwk'}),Buffer.from(pieces[2],'base64url'));
  if(!verified)throw Error('Invalid JWT signature');
  const now=Math.floor(Date.now()/1000);
  if(claims.iss!==OIDC_ISSUER || !(claims.aud===clientId() || Array.isArray(claims.aud)&&claims.aud.includes(clientId())))throw Error('Invalid JWT audience or issuer');
  if(!Number.isSafeInteger(claims.exp)||claims.exp<=now||!Number.isSafeInteger(claims.iat)||claims.iat>now+60||claims.iat<now-3600)throw Error('Invalid token lifetime');
  // Nonce is checked if supplied by Telegram. PKCE and single-use state are also required.
  if(claims.nonce !== undefined && claims.nonce !== expectedNonce)throw Error('OIDC nonce mismatch');
  const id = Number(claims.id);
  if(!Number.isSafeInteger(id)||id<=0||typeof claims.sub!=='string'||!claims.sub)throw Error('Invalid Telegram identity');
  return {id, first_name:String(claims.given_name||claims.name||'').slice(0,100),last_name:String(claims.family_name||'').slice(0,100),username:String(claims.preferred_username||'').slice(0,100)};
}
async function upsertUser(pool,user){
  const result=await pool.query(`INSERT INTO users (telegram_id,first_name,last_name,username)
    VALUES ($1,$2,$3,$4) ON CONFLICT (telegram_id) DO UPDATE SET
    first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,updated_at=now()
    RETURNING id,telegram_id,first_name,username,created_at`,[user.id,user.first_name||null,user.last_name||null,user.username||null]);
  return result.rows[0];
}
export async function pwaAuthenticatedUser(req,pool){
  const token=getCookies(req)[SESSION_COOKIE];
  if(!token||!(/^[\w-]{35,128}$/.test(token)))return null;
  const result=await pool.query(`SELECT u.id,u.telegram_id,u.first_name,u.username,u.created_at
  FROM pwa_sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token_hash=$1 AND s.expires_at>now()`,[sha(token)]);
  return result.rows[0]||null;
}
export function enforcePwaCsrf(req,res){
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return true;
  if(validOrigin(req))return true;
  safeErr(res,403,'PWA request origin mismatch');return false;
}
export async function handlePwaAuthRoute({req,res,pathname,pool}){
  if(!pathname.startsWith('/api/v1/auth/'))return false;
  if(!enabled()){safeErr(res,503,'PWA login is not configured');return true;}
  if(pathname==='/api/v1/auth/login'&&req.method==='GET'){
    const state=nonce(),verifier=nonce()+nonce(),loginNonce=nonce();
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    await pool.query('DELETE FROM pwa_auth_flows WHERE expires_at<now()');
    await pool.query('INSERT INTO pwa_auth_flows(state_hash,code_verifier,nonce,expires_at) VALUES ($1,$2,$3,$4)',[sha(state),verifier,loginNonce,new Date(Date.now()+STATE_TTL_MS)]);
    const auth=new URL(AUTH_URL);
    for(const [k,v] of Object.entries({client_id:clientId(),redirect_uri:callbackUri(),response_type:'code',scope:'openid profile',state,nonce:loginNonce,code_challenge:challenge,code_challenge_method:'S256'}))auth.searchParams.set(k,v);
    redirect(res,auth.toString(),[cookie(STATE_COOKIE,state,600)]);return true;
  }
  if(pathname==='/api/v1/auth/callback'&&req.method==='GET'){
    const params=new URL(req.url,'http://localhost').searchParams;
    const state=params.get('state'),code=params.get('code'),saved=getCookies(req)[STATE_COOKIE];
    if(!state||!code||state.length>256||code.length>4096||saved!==state){redirect(res,origin()+'/?login=failed',[expireCookie(STATE_COOKIE)]);return true;}
    // Consume exactly once. Parallel callbacks cannot reuse this flow.
    const f=await pool.query('DELETE FROM pwa_auth_flows WHERE state_hash=$1 AND expires_at>now() RETURNING code_verifier,nonce',[sha(state)]);
    if(!f.rowCount){redirect(res,origin()+'/?login=expired',[expireCookie(STATE_COOKIE)]);return true;}
    try{
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),9000);
      let tokenResponse;
      try{
        const form=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callbackUri(),client_id:clientId(),code_verifier:f.rows[0].code_verifier});
        tokenResponse=await fetch(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','authorization':'Basic '+Buffer.from(clientId()+':'+process.env.TELEGRAM_OIDC_CLIENT_SECRET).toString('base64')},body:form,signal:ctrl.signal});
      }finally{clearTimeout(timer)}
      if(!tokenResponse.ok)throw Error('Code exchange failed');
      const body=await tokenResponse.json();
      const telegramUser=await verifyTelegramIdToken(body.id_token,f.rows[0].nonce);
      const user=await upsertUser(pool,telegramUser);
      const session=nonce()+nonce();
      await pool.query('INSERT INTO pwa_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)',[sha(session),user.id,new Date(Date.now()+SESSION_TTL_MS)]);
      redirect(res,origin()+'/',[expireCookie(STATE_COOKIE),cookie(SESSION_COOKIE,session,Math.floor(SESSION_TTL_MS/1000))]);
    }catch(err){console.error('[PWA OIDC] Login failed:',err.message);redirect(res,origin()+'/?login=failed',[expireCookie(STATE_COOKIE)]);}
    return true;
  }
  if(pathname==='/api/v1/auth/me'&&req.method==='GET'){
    const user=await pwaAuthenticatedUser(req,pool);
    json(res,user?200:401,user?{user}:{error:'Not authenticated'});return true;
  }
  if(pathname==='/api/v1/auth/logout'&&req.method==='POST'){
    if(!enforcePwaCsrf(req,res))return true;
    const token=getCookies(req)[SESSION_COOKIE];
    if(token)await pool.query('DELETE FROM pwa_sessions WHERE token_hash=$1',[sha(token)]);
    json(res,200,{ok:true},{'set-cookie':expireCookie(SESSION_COOKIE)});return true;
  }
  safeErr(res,404,'Not found');return true;
}
