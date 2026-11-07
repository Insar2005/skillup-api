import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/bot.js',import.meta.url),'utf8');
const fn=source.match(/export async function withTelegramActivity\([\s\S]*?\n}\n/)[0].replace('export ','');
const context={telegram:async()=>{},Promise,Set,TypeError,Error,setInterval,clearInterval};
vm.runInNewContext(fn,context);
const activity=context.withTelegramActivity;
test('starts typing before processing',async()=>{
 const calls=[];
 const result=await activity(123,'typing',async()=>{assert.equal(calls.length,1);return 'done';},async(m,p)=>{calls.push([m,p.action,p.chat_id]);});
 assert.equal(result,'done');assert.equal(JSON.stringify(calls),JSON.stringify([['sendChatAction','typing',123]]));
});
test('propagates errors',async()=>{
 await assert.rejects(activity(123,'typing',async()=>{throw new Error('test-error');},async()=>{}),/test-error/);
});
test('rejects unsupported action',async()=>{
 await assert.rejects(activity(123,'pretend_upload',async()=>{},async()=>{}),/Unsupported/);
});
