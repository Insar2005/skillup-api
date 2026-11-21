import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyTelegramIdToken,enforcePwaCsrf} from '../src/pwa-auth.js';
const previousFetch=globalThis.fetch;
process.env.TELEGRAM_OIDC_CLIENT_ID='888000';
process.env.PWA_PUBLIC_ORIGIN='https://upniskillchipushila-production.up.railway.app';
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const kid='skillup-test';
const jwk=publicKey.export({format:'jwk'});jwk.kid=kid;jwk.use='sig';
globalThis.fetch=async()=>({ok:true,json:async()=>({keys:[jwk]})});
const now=Math.floor(Date.now()/1000);
const payload={iss:'https://oauth.telegram.org',aud:'888000',sub:'9999900000000',id:123456789,iat:now,exp:now+3600,nonce:'test-nonce'};
const makeToken=(claims)=>{
 const parts=[Buffer.from(JSON.stringify({alg:'RS256',kid,typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url')];
 return parts.join('.')+'.'+crypto.sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url');
};
try{
 const user=await verifyTelegramIdToken(makeToken(payload),'test-nonce');
 assert.equal(user.id,123456789);
 await assert.rejects(()=>verifyTelegramIdToken(makeToken({...payload,aud:'other'}),'test-nonce'));
 await assert.rejects(()=>verifyTelegramIdToken(makeToken({...payload,nonce:'other'}),'test-nonce'));
 await assert.rejects(()=>verifyTelegramIdToken(makeToken({...payload,exp:now-1}),'test-nonce'));
 const altered=makeToken(payload).replace(/.$/,'a');
 await assert.rejects(()=>verifyTelegramIdToken(altered,'test-nonce'));
 let code=0;
 assert.equal(enforcePwaCsrf({method:'POST',headers:{origin:process.env.PWA_PUBLIC_ORIGIN}},{writeHead(){throw Error('should not reject')}}),true);
 assert.equal(enforcePwaCsrf({method:'PUT',headers:{origin:'https://evil.invalid'}},{writeHead(s){code=s},end(){}}),false);
 assert.equal(code,403);
 console.log('6 security checks passed');
}finally{globalThis.fetch=previousFetch;}
