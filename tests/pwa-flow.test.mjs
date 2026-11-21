import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {handlePwaAuthRoute,pwaAuthenticatedUser} from '../src/pwa-auth.js';
process.env.PWA_PUBLIC_ORIGIN='https://upniskillchipushila-production.up.railway.app';
process.env.TELEGRAM_OIDC_CLIENT_ID='888000';
process.env.TELEGRAM_OIDC_CLIENT_SECRET='test-client-secret';
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'flow-kid',use:'sig'};
let flow,session,expectedNonce,exchangeCalled=false;
const pool={async query(query,args){
 if(query.startsWith('DELETE FROM pwa_auth_flows WHERE expires_at'))return {rowCount:0,rows:[]};
 if(query.startsWith('INSERT INTO pwa_auth_flows')){flow={hash:args[0],verifier:args[1],nonce:args[2],expires:args[3]};return {rowCount:1,rows:[]};}
 if(query.startsWith('DELETE FROM pwa_auth_flows WHERE state_hash')){
  if(!flow||flow.hash!==args[0])return {rowCount:0,rows:[]};
  const found=flow;flow=undefined;return {rowCount:1,rows:[{code_verifier:found.verifier,nonce:found.nonce}]};
 }
 if(query.startsWith('INSERT INTO users'))return {rowCount:1,rows:[{id:1,telegram_id:123456789,first_name:'Test',username:'test'}]};
 if(query.startsWith('INSERT INTO pwa_sessions')){session={hash:args[0],user_id:args[1],expires:args[2]};return {rowCount:1,rows:[]};}
 if(query.startsWith('SELECT u.id'))return {rowCount:session&&session.hash===args[0]?1:0,rows:session&&session.hash===args[0]?[{id:1,telegram_id:123456789,first_name:'Test',username:'test'}]:[]};
 throw Error('Unexpected query: '+query);
 }};
function fakeRes(){return {status:null,headers:null,body:'',writeHead(s,h){this.status=s;this.headers=h},end(v=''){this.body=v}}}
const origFetch=globalThis.fetch;
try{
 globalThis.fetch=async (url,options)=>{
  if(String(url).includes('jwks.json'))return {ok:true,json:async()=>({keys:[jwk]})};
  if(String(url).endsWith('/token')){
   exchangeCalled=true;
   assert.equal(options.headers.authorization,'Basic '+Buffer.from('888000:test-client-secret').toString('base64'));
   assert.equal(options.body.get('code_verifier'),flowBeforeCallback.verifier);
   const now=Math.floor(Date.now()/1000);
   const data={iss:'https://oauth.telegram.org',aud:'888000',iat:now,exp:now+3600,sub:'229922229922',id:123456789,nonce:expectedNonce,given_name:'Test',preferred_username:'test'};
   const p=[Buffer.from(JSON.stringify({alg:'RS256',kid:'flow-kid'})).toString('base64url'),Buffer.from(JSON.stringify(data)).toString('base64url')];
   return {ok:true,json:async()=>({id_token:p.join('.')+'.'+crypto.sign('RSA-SHA256',Buffer.from(p.join('.')),privateKey).toString('base64url')})};
  }
  throw Error('Unexpected external fetch '+url);
 };
 const res1=fakeRes();
 await handlePwaAuthRoute({req:{method:'GET',url:'/api/v1/auth/login',headers:{}},res:res1,pathname:'/api/v1/auth/login',pool});
 assert.equal(res1.status,302);
 const auth=new URL(res1.headers.location);
 assert.equal(auth.origin,'https://oauth.telegram.org');
 const state=auth.searchParams.get('state');
 expectedNonce=auth.searchParams.get('nonce');
 const flowBeforeCallback=flow;
 const req2={method:'GET',url:'/api/v1/auth/callback?state='+encodeURIComponent(state)+'&code=test-code',headers:{cookie:res1.headers['set-cookie'][0].split(';')[0]}};
 const res2=fakeRes();
 await handlePwaAuthRoute({req:req2,res:res2,pathname:'/api/v1/auth/callback',pool});
 assert.equal(res2.status,302);
 assert.equal(res2.headers.location,process.env.PWA_PUBLIC_ORIGIN+'/');
 assert.ok(exchangeCalled);
 const cookie=res2.headers['set-cookie'].find(x=>x.startsWith('__Host-su_session='));
 assert.ok(cookie.includes('Secure; HttpOnly; SameSite=Lax'));
 const current=await pwaAuthenticatedUser({headers:{cookie:cookie.split(';')[0]}},pool);
 assert.equal(current.telegram_id,123456789);
 const replay=fakeRes();
 await handlePwaAuthRoute({req:req2,res:replay,pathname:'/api/v1/auth/callback',pool});
 assert.ok(replay.headers.location.endsWith('login=expired'));
 console.log('OIDC flow & session integration checks passed');
}finally{globalThis.fetch=origFetch;}
