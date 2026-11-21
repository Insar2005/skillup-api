import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveFinanceSource,executeUnifiedTool,runUnifiedAgent,toolCatalog} from '../src/unified-agent.js';
const user={id:42,preferred_currency:'KGS'};
const saved=[];
const pool={
 async query(sql,args){
  if(sql.includes('SELECT payload FROM user_documents'))return {rowCount:1,rows:[{payload:{entries:saved,savingsGoal:null}}]};
  if(sql.includes('finance_action_history'))return {rows:[],rowCount:0};
  return {rowCount:1,rows:[]};
 },
 async connect(){return {query:async(sql,args)=>{
  if(sql.includes('SELECT payload FROM user_documents'))return {rowCount:1,rows:[{payload:{entries:saved,savingsGoal:null}}]};
  if(sql.includes('SELECT external_id FROM finance_action_history'))return {rowCount:0,rows:[]};
  if(sql.includes('UPDATE user_documents')){saved.length=0;saved.push(...JSON.parse(args[2]).entries);}
  return {rowCount:1,rows:[]};
 },release(){}};}
};
const deps={pool,user,development:{items:[],areas:[]},timezone:'Asia/Bishkek'};
test('reads direct compact expenses without needing magic trigger words',()=>{
 for(const t of ['-576 такси','−576 такси','393 сом за доставку резисторов'])assert.equal(resolveFinanceSource(t,[], 'KGS')?.intent.type,'Расход');
});
test('does not treat questions or negative commands as purchases',()=>{
 for(const t of ['Сколько 576 сом такси?', 'Не записывай 576 сом такси','Покажи 576 сом на такси'])assert.equal(resolveFinanceSource(t,[], 'KGS'),null);
});
test('recovers a pending previous user expense but not one already saved',()=>{
 const now=new Date().toISOString();
 assert.equal(resolveFinanceSource('сохрани сам',[{role:'user',content:'-576 такси',created_at:now},{role:'assistant',content:'Напиши подробнее',created_at:now}],'KGS')?.intent.amount,576);
 assert.equal(resolveFinanceSource('сохрани сам',[{role:'user',content:'-576 такси',created_at:now},{role:'assistant',content:'Записал -576 KGS',created_at:now}],'KGS'),null);
 assert.equal(resolveFinanceSource('сохрани сам',[{role:'user',content:'-576 такси',created_at:'2020-01-01T00:00:00Z'}],'KGS'),null);
});
test('read tools never take model-supplied user ID',async()=>{
 const res=await executeUnifiedTool({name:'list_finances',message:'Покажи расходы',key:'x',...deps,args:{user_id:999}});
 assert.equal(res.result.count,0);
});
test('model cannot alter amount, currency or expense type',async()=>{
 const result=await executeUnifiedTool({name:'record_finance',message:'-576 такси',key:'x',...deps,args:{amount:576,currency:'USD',direction:'Расход',description:'такси'}});
 assert.equal(result.result.error,'amount_currency_or_type_mismatch');assert.equal(saved.length,0);
});
test('real model function call writes to trusted finance document exactly once',async()=>{
 const request=async()=>({ok:true,json:async()=>({output:[{type:'function_call',name:'record_finance',call_id:'call1',arguments:JSON.stringify({amount:576,currency:'KGS',direction:'Расход',description:'такси'})}]})});
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
 try{
  const answer=await runUnifiedAgent({message:'-576 такси',history:[],key:'bot:123',request,provider:'openai',...deps});
  assert.match(answer,/Записал/);assert.equal(saved[0].amount,576);assert.equal(saved[0].currency,'KGS');assert.equal(saved[0].category,'Транспорт');
 }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
test('model output without a tool cannot falsely claim a clear expense is recorded',async()=>{
 saved.length=0;
 const request=async()=>({ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Я записал 80 сомов.'}]}]})});
 const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
 try{const result=await runUnifiedAgent({message:'80 сомов за кофе',key:'bot:124',provider:'openai',request,...deps});assert.match(result,/Записал/);assert.equal(saved[0].amount,80);assert.equal(saved[0].category,'Еда вне дома');}
 finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});
test('tool catalog has strict known names',()=>{assert.ok(toolCatalog.find(x=>x.name==='record_finance'));assert.ok(!toolCatalog.find(x=>x.name==='run_sql'));});
test('Anthropic uses the exact same audited tool execution',async()=>{
 saved.length=0;
 const request=async()=>({ok:true,json:async()=>({content:[{type:'tool_use',id:'claude_call1',name:'record_finance',input:{amount:576,currency:'KGS',direction:'Расход',description:'такси'}}]})});
 const old=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-key';
 try{
  const answer=await runUnifiedAgent({message:'−576 такси',history:[],key:'bot:125',request,provider:'anthropic',...deps});
  assert.match(answer,/Записал/);assert.equal(saved[0].amount,576);
 }finally{if(old===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=old;}
});
