// v29.10: deterministic outage fallback. No model calls, no guessed mutations.
// The same trusted user, external key and PostgreSQL tables as the agent.
import {resolveFinanceSource} from './unified-agent.js';
import {appendFinance,financeReply} from './ai-finance.js';
import {localExpenseCategory} from './category.js';
import {resolveSavingsGoal,applySavingsGoal} from './goal-intents.js';

const unavailable='ИИ сейчас недоступен. Простые доходы и расходы, а также просмотр записей продолжают работать. Для сложных изменений попробуй позже.';
const n=v=>Number(v||0).toLocaleString('ru-RU',{maximumFractionDigits:2});
const readIntent=t=>/^(?:покажи|посмотри|перечисли|сколько|какие|какой|отч[её]т|мои|что у меня|последние)/iu.test(t);
const financeRead=t=>/(?:расход|доход|трат|покупк|операц|финанс|потратил)/iu.test(t);
const goalRead=t=>/(?:цел[ьи]|направлен|навык|привыч)/iu.test(t);
const groups=entries=>{
 const out={};for(const e of entries){if(!['Расход','Доход'].includes(e.type))continue;
  const k=`${e.type}:${e.currency||'RUB'}`;out[k]=(out[k]||0)+Number(e.amount||0);
 }return out;
};
export async function serverFallback({pool,user,message,history=[],key}){
 if(!pool||!user?.id||!key)throw new Error('Authenticated context required');
 const t=String(message||'').trim();
 if(!t)return {answer:unavailable,changed:false};
 // Financial savings goals are safe, explicit actions even if the model is offline.
 // Use the same action key as the normal unified agent, preventing duplicates
 // if the provider fails after the operation was committed.
 const savings=resolveSavingsGoal(t,history,user.preferred_currency||'RUB');
 if(savings){
  const result=await applySavingsGoal({pool,user,key:`${key}:savings`,goal:savings});
  return {answer:result.text,changed:!!result.changed,domain:'finances'};
 }
 // Prioritize read operations. Never interpret a question as a write.
 if(readIntent(t)&&financeRead(t)){
  const r=await pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='finances'",[user.id]);
  const entries=Array.isArray(r.rows[0]?.payload?.entries)?r.rows[0].payload.entries:[];
  const recent=entries.slice(0,5).map(e=>`${e.type==='Расход'?'−':'+'}${n(e.amount)} ${e.currency||'RUB'} · ${String(e.category||'Прочее').slice(0,40)}`);
  const totals=Object.entries(groups(entries)).map(([k,v])=>`${k.replace(':',' ')}: ${n(v)}`);
  return {answer:entries.length?`Последние операции:\n${recent.join('\n')}\nИтоги по валютам:\n${totals.join('\n')}`:'Финансовых операций пока нет.',changed:false};
 }
 if(readIntent(t)&&goalRead(t)){
  const r=await pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development'",[user.id]);
  const doc=r.rows[0]?.payload||{};
  const items=Array.isArray(doc.items)?doc.items:[];
  const areas=Array.isArray(doc.areas)?doc.areas:[];
  return {answer:`Направления: ${areas.slice(0,12).map(a=>String(a.title||a.name||'Без названия').slice(0,60)).join(', ')||'нет'}.\nЦели и другие элементы: ${items.length}.`,changed:false};
 }
 // A verified, unambiguous finance instruction can be committed offline.
 // Reuse the request id: if the model had already written and then failed,
 // appendFinance sees the same external_id and never writes a duplicate.
 const resolved=resolveFinanceSource(t,history,user.preferred_currency||'RUB');
 if(resolved){
  const intent=resolved.intent;
  const entry={...intent,category:localExpenseCategory(resolved.source)||intent.category||'Прочее'};
  const saved=await appendFinance(pool,user,[entry],key,key.startsWith('bot:')?'telegram_bot':'chat');
  return {answer:saved.added?financeReply(entry,saved.entries):'Эта операция уже была обработана. Повторную запись не создавал.',changed:!!saved.added,domain:'finances'};
 }
 // Never bulk delete, edit an unspecified target, or claim a write happened.
 return {answer:unavailable,changed:false};
}
