// A narrow, non-LLM path for clear income/expense statements.
// Any ambiguous sentence goes to Claude instead of silently creating a transaction.
import {extractAmount} from './bot-finance.js';
const currencies={RUB:/\bRUB\b|рубл|руб\b|₽/iu,KGS:/\bKGS\b|сом(?:ов|а)?(?=\s|$|[,.!?])|сому|сомы/iu,USD:/\bUSD\b|доллар|\$/iu,EUR:/\bEUR\b|евро|€/iu,KZT:/\bKZT\b|тенге|₸/iu,UZS:/\bUZS\b|сум(?:ов|а)?\b/iu,CNY:/\bCNY\b|юан|¥/iu};
const categories=[
 ['Гаджеты',/айпад|ipad|iphone|айфон|ноутбук|телефон|планшет|гаджет|компьютер|смартфон/iu],
 ['Продукты',/продукт|магазин|рынок|молоко|хлеб|фрукт|овощ|мясо|супермаркет/iu],
 ['Еда вне дома',/кафе|ресторан|шаурм|обед|ужин|пицц|кофе/iu],
 ['Транспорт',/такси|бензин|заправ|дизель|автобус|транспорт|парковк/iu],
 ['Жилье',/квартир|аренд|коммунал|мебел|шкаф|ремонт|электричеств|интернет/iu],
 ['Здоровье',/аптек|лекарств|врач|больниц|витамин/iu],
 ['Личные расходы',/сигарет|табак|вейп|косметик|одежд|обув|парикмахер/iu]
];
export function parseFinanceIntent(text, defaultCurrency='RUB'){
 const t=String(text||'').trim();if(!t||t.length>1500)return null;
 if(/[?？]/.test(t)||/^(сколько|как|почему|что мне|отч[её]т|покажи|подсчитай|проанализируй|можно ли|хочу)/iu.test(t))return null;
 const income=/(?:получил|заработал|зарплат|аванс|поступил|пришли деньги|преми|продал|выручк|доход)/iu.test(t);
 const expense=/(?:купил|купила|потратил|потратила|оплатил|оплатила|заплатил|заплатила|взял|заказал|расход|списал)/iu.test(t);
 const shorthand=/^(?:\s*\d[\d\s.,]*(?:\s*(?:сом|сомов|₽|руб|доллар|usd|kgs|евро|eur))?\s+на\s+.{2,})$/iu.test(t);
 if(income&&expense)return null;
 if(!income&&!expense&&!shorthand)return null;
 const amount=extractAmount(t);if(!Number.isSafeInteger(amount)||amount<=0||amount>9999999999)return null;
 const explicit=Object.keys(currencies).filter(k=>currencies[k].test(t));if(explicit.length>1)return null;
 const currency=explicit[0]||defaultCurrency;
 const direction=income?'Доход':'Расход';
 const category=income?(/зарплат|оклад|аванс/iu.test(t)?'Зарплата':'Прочие доходы'):(categories.find(([,re])=>re.test(t))?.[0]||'Прочее');
 return {type:direction,amount,currency,category,note:t.slice(0,250)};
}
// Treat short corrective commands as DB actions, never as ordinary Claude chat.
export function financeCorrectionIntent(text){
 const t=String(text||'').trim().toLowerCase().replace(/[.!?]+$/u,'').trim();
 if(/^(верни|вернуть|восстанови|восстановить|верни последнюю(?: отмен[её]нную)? операцию|восстанови последнюю(?: отмен[её]нную)? операцию|верни расход|восстанови расход)$/u.test(t))return 'restore';
 return null;
}
export async function appendFinance(pool,user,items,externalBase,source){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const row=await client.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  const payload=row.rows[0]?.payload||{entries:[],savingsGoal:null};
  if(!Array.isArray(payload.entries)||payload.entries.length+items.length>500)throw new Error('Too many finance entries');
  const ids=new Set(payload.entries.map(x=>x.externalId));
  const candidates=items.map((x,i)=>({type:x.type,category:x.category,note:x.note,amount:x.amount,currency:x.currency,date:new Date().toISOString(),externalId:`${externalBase}:${i}`,source}));
  // A webhook replay after an undo must NOT recreate a cancelled transaction.
  const prior=await client.query('SELECT external_id FROM finance_action_history WHERE user_id=$1 AND external_id=ANY($2::text[])',[user.id,candidates.map(x=>x.externalId)]);
  const previouslyHandled=new Set(prior.rows.map(x=>x.external_id));
  const newEntries=candidates.filter(x=>!ids.has(x.externalId)&&!previouslyHandled.has(x.externalId));
  const next={...payload,entries:[...newEntries,...payload.entries]};
  if(newEntries.length){
   if(row.rowCount)await client.query("UPDATE user_documents SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind=$2",[user.id,'finances',JSON.stringify(next)]);
   else await client.query("INSERT INTO user_documents(user_id,kind,payload) VALUES($1,'finances',$2::jsonb)",[user.id,JSON.stringify(next)]);
   for(const entry of newEntries){
     await client.query("INSERT INTO finance_action_history(user_id,external_id,entry,state) VALUES($1,$2,$3::jsonb,'active') ON CONFLICT DO NOTHING",[user.id,entry.externalId,JSON.stringify(entry)]);
   }
  }
  await client.query('COMMIT');
  return {added:newEntries.length,entries:next.entries};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export function summarizeToday(entries,currency){const day=new Date().toISOString().slice(0,10);return entries.filter(x=>x.type==='Расход'&&(x.currency||'RUB')===currency&&String(x.date).slice(0,10)===day).reduce((n,x)=>n+Number(x.amount||0),0);}
export function financeReply(item,entries){const d=item.type==='Расход'?'−':'+';const fmt=n=>Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});return `Записал: ${d}${fmt(item.amount)} ${item.currency} · ${item.category}.${item.type==='Расход'?` Расходы за сегодня: ${fmt(summarizeToday(entries,item.currency))} ${item.currency}.`:''}`;}
// Each cancellation retains the exact original entry, not an LLM reconstruction.
export async function undoFinanceExternal(pool,user,externalId){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const row=await c.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  const doc=row.rows[0]?.payload;
  if(!Array.isArray(doc?.entries)){await c.query('ROLLBACK');return false;}
  const entry=doc.entries.find(e=>e.externalId===externalId);
  if(!entry){await c.query('ROLLBACK');return false;}
  const entries=doc.entries.filter(e=>e.externalId!==externalId);
  await c.query("UPDATE user_documents SET payload=$2::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='finances'",[user.id,JSON.stringify({...doc,entries})]);
  await c.query(`INSERT INTO finance_action_history(user_id,external_id,entry,state,undone_at)
    VALUES($1,$2,$3::jsonb,'undone',now())
    ON CONFLICT(user_id,external_id) DO UPDATE SET entry=EXCLUDED.entry,state='undone',undone_at=now()`,[user.id,externalId,JSON.stringify(entry)]);
  await c.query('COMMIT');return true;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function restoreFinanceExternal(pool,user,externalId){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const docRow=await c.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  const history=await c.query("SELECT entry,state FROM finance_action_history WHERE user_id=$1 AND external_id=$2 FOR UPDATE",[user.id,externalId]);
  if(!history.rowCount||history.rows[0].state!=='undone'){await c.query('ROLLBACK');return null;}
  const doc=docRow.rows[0]?.payload||{entries:[],savingsGoal:null};
  if(!Array.isArray(doc.entries)||doc.entries.some(e=>e.externalId===externalId)||doc.entries.length>=500){await c.query('ROLLBACK');return null;}
  const entry=history.rows[0].entry;
  if(!entry||entry.externalId!==externalId||!['Расход','Доход'].includes(entry.type)||!Number.isFinite(Number(entry.amount))){await c.query('ROLLBACK');return null;}
  const updated={...doc,entries:[entry,...doc.entries]};
  if(docRow.rowCount)await c.query("UPDATE user_documents SET payload=$2::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='finances'",[user.id,JSON.stringify(updated)]);
  else await c.query("INSERT INTO user_documents(user_id,kind,payload) VALUES($1,'finances',$2::jsonb)",[user.id,JSON.stringify(updated)]);
  await c.query("UPDATE finance_action_history SET state='active',restored_at=now() WHERE user_id=$1 AND external_id=$2",[user.id,externalId]);
  await c.query('COMMIT');return {externalId,entry};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function restoreLastFinance(pool,user){
 const rows=await pool.query(`SELECT external_id FROM finance_action_history
   WHERE user_id=$1 AND state='undone' AND undone_at>now()-interval '24 hours'
   ORDER BY undone_at DESC LIMIT 1`,[user.id]);
 if(!rows.rowCount)return null;
 return restoreFinanceExternal(pool,user,rows.rows[0].external_id);
}
export function restoredFinanceReply(entry){
 const sign=entry.type==='Расход'?'−':'+';
 return `Восстановил операцию: ${sign}${Number(entry.amount).toLocaleString('ru-RU')} ${entry.currency||'RUB'} · ${entry.category}.`;
}
