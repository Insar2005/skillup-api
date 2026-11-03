import assert from 'node:assert/strict';
import test from 'node:test';
import {buildProgressReport,buildAgentContext,generateAgentAnswer,normalizeTimezone,validateInputMessage} from '../src/ai.js';
const doc={areas:[{id:'a',name:'Обучение'}],items:[{
 id:'eng',areaId:'a',kind:'goal',title:'Английский',steps:[{id:'one',title:'Найти ресурсы',done:true},{id:'two',title:'Практика',done:false}],
 startedAt:'2026-10-30',actions:[{id:'first',title:'15 минут',days:[1,3,5]},{id:'second',title:'Повторить',days:[2,4]}],
 completed:{'2026-11-02':true}, actionCompleted:{second:{'2026-11-03':true}}
}]};
const now=new Date('2026-11-03T15:00:00.000Z');
test('timezone and dated week preserve exact local days',()=>{
 const r=buildProgressReport(doc,7,'Asia/Bishkek',now);
 assert.equal(r.localDate,'2026-11-03');
 assert.equal(r.planned,3);
 assert.equal(r.done,2);
 assert.equal(r.percent,67);
 assert.equal(r.items[0].stepsDone,1);
});
test('without completion entries no fabricated success',()=>{
 const r=buildProgressReport({...doc,items:[{...doc.items[0],completed:{},actionCompleted:{}}]},7,'Asia/Bishkek',now);
 assert.equal(r.done,0);assert.equal(r.percent,0);
});
test('item-specific focus is server-owned and arbitrary id is ignored',()=>{
 assert.equal(buildAgentContext(doc,'Asia/Bishkek',now,'eng').focus.title,'Английский');
 assert.equal(buildAgentContext(doc,'Asia/Bishkek',now,'not-owned').focus,null);
});
test('bad timezone and prompts are bounded',()=>{
 assert.equal(normalizeTimezone('fake/timezone'),'UTC');
 assert.equal(validateInputMessage('   '),false);
 assert.equal(validateInputMessage('a'.repeat(1501)),false);
 assert.equal(validateInputMessage('Помоги с планом'),true);
});
test('agent returns text; model history is constrained, server-derived and read-only',async()=>{
 const calls=[];
 const provider=async body=>{calls.push(body);return {content:[{type:'text',text:'План: три шага и регулярная практика.'}]}};
 const result=await generateAgentAnswer({message:'Помоги',history:[{role:'user',content:'Ранее'}],development:doc,timezone:'Asia/Bishkek',focusItemId:'eng',now,provider});
 assert.match(result,/План/);
 assert.match(calls[0].system,/НЕ проводишь уроки/);
 assert.equal(calls[0].tools.every(t=>t.name.startsWith('get_')||t.name==='list_goals'),true);
 assert.equal(calls[0].messages.at(-1).content,'Помоги');
});
test('agent invokes read-only progress tool and produces final answer',async()=>{
 let second;
 const provider=async body=>{if(body.messages.length<=1)return {content:[{type:'tool_use',id:'tool_a',name:'get_progress_report',input:{days:7}}]};second=body;return {content:[{type:'text',text:'Выполнено 2 из 3.'}]};};
 const result=await generateAgentAnswer({message:'Отчёт',history:[],development:doc,timezone:'Asia/Bishkek',now,provider});
 assert.match(result,/2 из 3/);
 const returned=JSON.parse(second.messages.at(-1).content[0].content);
 assert.equal(returned.done,2);assert.equal(returned.planned,3);
});
