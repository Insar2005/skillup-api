import test from 'node:test';
import assert from 'node:assert/strict';
import {serverFallback} from '../src/agent-fallback.js';

function mockDb(){
 let doc={entries:[],savingsGoal:null},history=new Set();let writes=0;
 const client={
  async query(sql,args=[]){
   if(/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql))return {rowCount:0,rows:[]};
   if(sql.includes('FROM user_documents')&&sql.includes("kind='finances'"))return {rowCount:1,rows:[{payload:doc}]};
   if(sql.includes('FROM finance_action_history'))return {rowCount:0,rows:[]};
   if(sql.includes('UPDATE user_documents')){doc=JSON.parse(args[2]??args[1]);writes++;return {rowCount:1,rows:[]};}
   if(sql.includes('INSERT INTO finance_action_history')){history.add(args[1]);return {rowCount:1,rows:[]};}
   throw new Error('Unexpected SQL '+sql);
  },release(){}
 };
 return {pool:{connect:async()=>client,query:client.query},getEntries:()=>doc.entries,getWrites:()=>writes};
}
const user={id:24,preferred_currency:'KGS'};
test('short expense is saved in default currency with exact amount',async()=>{
 const {pool,getEntries}=mockDb();
 const result=await serverFallback({pool,user,message:'-576 такси',key:'bot:101'});
 assert.equal(result.changed,true);assert.equal(getEntries()[0].amount,576);assert.equal(getEntries()[0].currency,'KGS');assert.equal(getEntries()[0].category,'Транспорт');
});
test('same external request cannot create a second transaction',async()=>{
 const {pool,getEntries}=mockDb();
 await serverFallback({pool,user,message:'-576 такси',key:'bot:102'});
 const second=await serverFallback({pool,user,message:'-576 такси',key:'bot:102'});
 assert.equal(getEntries().length,1);assert.equal(second.changed,false);
});
test('question never writes a transaction',async()=>{
 const {pool,getWrites}=mockDb();
 await serverFallback({pool,user,message:'Сколько я потратил на такси?',key:'bot:103'});
 assert.equal(getWrites(),0);
});
test('bulk deletion and ambiguous text are not performed',async()=>{
 const {pool,getWrites}=mockDb();
 const result=await serverFallback({pool,user,message:'Удали все мои цели',key:'bot:104'});
 assert.equal(result.changed,false);assert.equal(getWrites(),0);
});
test('reads actual finance entries from database',async()=>{
 const {pool}=mockDb();
 const result=await serverFallback({pool,user,message:'Покажи последние расходы',key:'bot:105'});
 assert.match(result.answer,/нет/i);
});
