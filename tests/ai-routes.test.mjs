import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAiRoute} from '../src/ai-routes.js';
function capture(){let status,payload,headers;return {res:{writeHead(s,h){status=s;headers=h;},end(t){payload=JSON.parse(t);}},result:()=>({status,payload,headers})};}
test('history read is strictly user_id scoped',async()=>{
 const observed=[];const pool={query:async(q,args)=>{observed.push([q,args]);return {rows:[{id:'7',role:'user',text:'Привет',created_at:'2026-11-03T00:00:00Z'}]}}};
 const response=capture();await handleAiRoute({req:{method:'GET'},res:response.res,pathname:'/api/v1/ai/history',pool,user:{id:'123'},cors:{'access-control-allow-origin':'https://example.com'}});
 assert.equal(response.result().status,200);assert.equal(observed[0][1][0],'123');assert.match(observed[0][0],/WHERE user_id=\$1/);assert.equal(response.result().payload.messages[0].text,'Привет');
});
test('chat refuses to use a provider without server-side API key',async()=>{
 const was=process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_API_KEY;
 try{const response=capture();await handleAiRoute({req:{method:'POST'},res:response.res,pathname:'/api/v1/ai/chat',pool:{},user:{id:'123'},cors:{},readJsonBody:async()=>({message:'Тест'})});assert.equal(response.result().status,503);assert.equal(response.result().payload.error,'ai_unconfigured');}
 finally{if(was)process.env.ANTHROPIC_API_KEY=was;}
});
test('legacy import requires explicit confirmation',async()=>{
 const response=capture();await handleAiRoute({req:{method:'POST'},res:response.res,pathname:'/api/v1/ai/import-legacy',pool:{},user:{id:'123'},cors:{},readJsonBody:async()=>({confirmed:false,messages:[{role:'user',text:'X',at:Date.now(),scope:'general'}]})});
 assert.equal(response.result().status,400);
});
