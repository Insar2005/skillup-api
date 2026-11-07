import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFinanceIntent} from '../src/ai-finance.js';
import {executeOpenAITool,generateOpenAIAnswer} from '../src/openai-agent.js';

const user={id:123,preferred_currency:'KGS'};
const ctx={areas:[],items:[]};
function params(text,args={direction:'Расход',amount:576,currency:'KGS',description:'такси'}){
 return {name:'record_finance',args,original:text,pool:{},user,key:'bot:1',development:ctx,timezone:'Asia/Bishkek'};
}
test('short form with minus saved by deterministic path',()=>{
 for(const t of ['-576 такси','−576 такси']){
  const x=parseFinanceIntent(t,'KGS');assert.equal(x.amount,576);assert.equal(x.type,'Расход');assert.equal(x.category,'Транспорт');
 }
});
test('questions do not automatically become finance entries',()=>{
 assert.equal(parseFinanceIntent('Сколько я потратил на такси 576 сом?','KGS'),null);
});
test('model cannot change amount',async()=>{
 const x=await executeOpenAITool(params('−576 такси',{direction:'Расход',amount:5760,currency:'KGS',description:'такси'}));
 assert.equal(x.result.error,'amount_mismatch');
});
test('model cannot change currency',async()=>{
 const x=await executeOpenAITool(params('−576 такси',{direction:'Расход',amount:576,currency:'USD',description:'такси'}));
 assert.equal(x.result.error,'currency_mismatch');
});
test('model cannot turn question into a debit',async()=>{
 const x=await executeOpenAITool(params('Сколько стоило такси 576 сом?'));
 assert.equal(x.result.error,'not_an_explicit_write_request');
});
test('allowed summary uses authenticated user id',async()=>{
 let args;
 const pool={query:async(sql,vals)=>{args=vals;return {rows:[{payload:{entries:[{type:'Расход',amount:80,currency:'KGS',category:'Транспорт'}]}}]}}};
 const x=await executeOpenAITool({...params('Покажи мои расходы'),name:'get_finance_summary',pool});
 assert.deepEqual(args,[123]);assert.equal(x.result.recent[0].amount,80);
});
test('OpenAI text answer without tool is supported',async()=>{
 process.env.OPENAI_API_KEY='test-not-real';
 const request=async()=>({ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Ваш прогресс: 3 из 4.'}]}]})});
 const answer=await generateOpenAIAnswer({message:'Как дела с прогрессом?',history:[],development:ctx,timezone:'Asia/Bishkek',pool:{},user,key:'bot:test',request});
 assert.match(answer,/3 из 4/);
});
