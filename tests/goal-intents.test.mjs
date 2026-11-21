import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSavingsGoal,resolveSavingsGoal,applySavingsGoal} from '../src/goal-intents.js';

test('natural savings phrase maps into a structured savings goal, not development goal',()=>{
 const value=parseSavingsGoal('Цель собрать 10000 сомов до 30.11.2026');
 assert.equal(value.target,10000);assert.equal(value.currency,'KGS');assert.equal(value.deadline,'2026-11-30');assert.equal(value.saved,0);
});
test('implicit currency follows user preference',()=>{
 assert.equal(parseSavingsGoal('Хочу накопить 5000','KGS').currency,'KGS');
});
test('question, negation, invalid date and impossible amount do not mutate',()=>{
 for(const s of ['Не создавай цель накопить 10000 сом','Сколько накопить 10000 сом?','Цель собрать 5000 сом до 31.02.2026','Цель накопить -5 сом'])assert.equal(parseSavingsGoal(s),null,s);
});
test('one-word create uses fresh prior user request but not expired context',()=>{
 const now=Date.now();const history=[{role:'user',content:'Цель собрать 10000 сом до 30.11.2026',created_at:new Date(now-30000).toISOString()},{role:'assistant',content:'Что сделать?',created_at:new Date(now-20000).toISOString()}];
 assert.equal(resolveSavingsGoal('Создать',history,'RUB',now).currency,'KGS');
 assert.equal(resolveSavingsGoal('Создать',history,'RUB',now+660000),null);
});
function fakePool(payload={entries:[],savingsGoal:null},revision=1){
 const state={payload:structuredClone(payload),revision,log:new Map(),updates:0};
 const client={query:async(sql,params=[])=>{
  if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))return {rowCount:0,rows:[]};
  if(sql.includes('SELECT result FROM agent_action_log')){const v=state.log.get(params[1]);return {rowCount:v?1:0,rows:v?[{result:v}]:[]};}
  if(sql.includes("SELECT payload,revision FROM user_documents"))return {rowCount:1,rows:[{payload:structuredClone(state.payload),revision:state.revision}]};
  if(sql.startsWith('UPDATE user_documents')){state.payload=JSON.parse(params[2]);state.revision++;state.updates++;return {rowCount:1,rows:[]};}
  if(sql.startsWith('INSERT INTO agent_action_log')){state.log.set(params[1],JSON.parse(params[5]));return {rowCount:1,rows:[]};}
  throw new Error('unexpected sql: '+sql);
 },release:()=>{}};
 return {connect:async()=>client,state};
}
test('save is idempotent and does not overwrite an existing goal',async()=>{
 const pool=fakePool();const user={id:101};const goal=parseSavingsGoal('Цель собрать 10000 сом до 30.11.2026');
 const first=await applySavingsGoal({pool,user,key:'bot:1:savings',goal});
 assert.equal(first.changed,true);assert.equal(pool.state.payload.savingsGoal.target,10000);
 const replay=await applySavingsGoal({pool,user,key:'bot:1:savings',goal});assert.equal(replay.duplicate,true);
 const second=await applySavingsGoal({pool,user,key:'bot:2:savings',goal});assert.equal(second.changed,false);
 assert.equal(pool.state.updates,1);
});
test('different savings goal cannot silently overwrite existing savings goal',async()=>{
 const pool=fakePool({entries:[],savingsGoal:{target:3000,currency:'USD',name:'Old',saved:150}});
 const r=await applySavingsGoal({pool,user:{id:1},key:'bot:5:savings',goal:parseSavingsGoal('накопить 5000 сом')});
 assert.equal(r.changed,false);assert.equal(pool.state.payload.savingsGoal.saved,150);
});
