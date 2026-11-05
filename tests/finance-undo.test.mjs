import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFinanceIntent, financeCorrectionIntent,appendFinance,undoFinanceExternal,restoreFinanceExternal,restoreLastFinance,restoredFinanceReply} from '../src/ai-finance.js';

// Transaction-level fake for the specific read/write contract; live PG migration must
// still be verified on Railway before claiming production success.
class Db {
 constructor(){this.docs=new Map();this.events=new Map();}
 key(user,external){return `${user}:${external}`;}
 async connect(){return {query:(sql,args)=>this.query(sql,args),release(){}};}
 async query(sql, args=[]){
   const s=sql.replace(/\s+/g,' ').trim();
   const out=rows=>({rows,rowCount:rows.length});
   if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(s))return out([]);
   if(s.startsWith('SELECT payload FROM user_documents'))return this.docs.has(String(args[0]))?out([{payload:structuredClone(this.docs.get(String(args[0])))}]):out([]);
   if(s.startsWith('SELECT external_id FROM finance_action_history')&&s.includes('ANY('))return out(args[1].filter(x=>this.events.has(this.key(args[0],x))).map(x=>({external_id:x})));
   if(s.startsWith('SELECT external_id FROM finance_action_history')&&s.includes("state='undone'")){
     const options=[...this.events.entries()].filter(([key,value])=>key.startsWith(String(args[0])+':')&&value.state==='undone');
     options.sort((a,b)=>b[1].undoneAt-a[1].undoneAt);
     return options.length?out([{external_id:options[0][1].externalId}]):out([]);
   }
   if(s.startsWith('SELECT entry,state FROM finance_action_history')){
     const item=this.events.get(this.key(args[0],args[1]));return item?out([{entry:structuredClone(item.entry),state:item.state}]):out([]);
   }
   if(s.startsWith('INSERT INTO user_documents')){this.docs.set(String(args[0]),JSON.parse(args[1]));return out([]);}
   if(s.startsWith('UPDATE user_documents')){
     this.docs.set(String(args[0]),JSON.parse(args[s.includes('payload=$3')?2:1]));return out([]);
   }
   if(s.startsWith('INSERT INTO finance_action_history')){
     const key=this.key(args[0],args[1]);
     if(s.includes("state,undone_at")){
       this.events.set(key,{externalId:args[1],entry:JSON.parse(args[2]),state:'undone',undoneAt:Date.now()});
     }else if(!this.events.has(key))this.events.set(key,{externalId:args[1],entry:JSON.parse(args[2]),state:'active',undoneAt:0});
     return out([]);
   }
   if(s.startsWith("UPDATE finance_action_history SET state='active'")){
     this.events.get(this.key(args[0],args[1])).state='active';return out([]);
   }
   throw new Error(`Unhandled test SQL: ${s}`);
 }
 entries(id=1){return this.docs.get(String(id))?.entries||[];}
}

test('short restore command is handled by finance engine rather than Claude',()=>{
 assert.equal(financeCorrectionIntent('Верни'),'restore');
 assert.equal(financeCorrectionIntent('Восстанови последнюю отменённую операцию!'),'restore');
 assert.equal(financeCorrectionIntent('Верни мне мотивацию'),null);
});

test('cancel and restore exact KGS entry without duplicates, preserving original metadata',async()=>{
 const db=new Db(),user={id:1};
 const original=parseFinanceIntent('Купил самсу за 80 сомов','USD');
 assert.equal(original.amount,80);assert.equal(original.currency,'KGS');
 const result=await appendFinance(db,user,[original],'bot:12345','telegram_bot');
 assert.equal(result.added,1); assert.equal(db.entries().length,1);
 const before=structuredClone(db.entries()[0]);
 assert.equal(await undoFinanceExternal(db,user,'bot:12345:0'),true);
 assert.equal(db.entries().length,0);
 assert.equal(await undoFinanceExternal(db,user,'bot:12345:0'),false);
 const restored=await restoreLastFinance(db,user);
 assert.deepEqual(restored.entry,before);
 assert.match(restoredFinanceReply(restored.entry),/80 KGS/);
 assert.equal(db.entries().length,1);
 assert.equal(await restoreFinanceExternal(db,user,'bot:12345:0'),null);
 assert.equal(db.entries().length,1);
});

test('webhook replay after undo cannot recreate operation; other user cannot restore',async()=>{
 const db=new Db(),one={id:1},two={id:2};
 const item=parseFinanceIntent('Потратил 50 сомов на продукты','KGS');
 await appendFinance(db,one,[item],'bot:987','telegram_bot');
 await undoFinanceExternal(db,one,'bot:987:0');
 const replay=await appendFinance(db,one,[item],'bot:987','telegram_bot');
 assert.equal(replay.added,0);
 assert.equal(db.entries(1).length,0);
 assert.equal(await restoreFinanceExternal(db,two,'bot:987:0'),null);
 assert.equal((await restoreLastFinance(db,one))?.entry.amount,50);
 assert.equal(db.entries(1).length,1);
 assert.equal(db.entries(2).length,0);
});
