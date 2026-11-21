// SkillUp v29.11: server-verified savings goals with conversational follow-up.
// This module never guesses a parent direction or overwrites an existing goal.
const normalize = s => String(s||'').trim().toLocaleLowerCase('ru-RU');
const curMap = new Map([['сом','KGS'],['сома','KGS'],['сомов','KGS'],['kgs','KGS'],['руб','RUB'],['рублей','RUB'],['рубля','RUB'],['рубль','RUB'],['₽','RUB'],['rub','RUB'],['доллар','USD'],['долларов','USD'],['доллара','USD'],['usd','USD'],['$','USD']]);
const amountPattern='(\\d[\\d\\s\\u00a0]*(?:[.,]\\d{1,2})?)';
const currencyPattern='(сомов|сома|сом|kgs|рублей|рубля|рубль|руб|₽|rub|долларов|доллара|доллар|usd|\\$)';
const goalRE=new RegExp('^(?:(?:создай|добавь|запиши|поставь|хочу|моя|новая)\\s+)?(?:финансовую\\s+)?(?:цель\\s+)?(?:накопить|собрать|накопления\\s+на)\\s+'+amountPattern+'\\s*'+currencyPattern+'?(?:\\s+(?:до|к)\\s+(\\d{2}\\.\\d{2}\\.\\d{4}))?[.!]?$', 'iu');
function isoDate(str){if(!str)return null;const a=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(str);if(!a)return null;const y=+a[3],m=+a[2],d=+a[1];const date=new Date(Date.UTC(y,m-1,d));if(date.getUTCFullYear()!==y||date.getUTCMonth()+1!==m||date.getUTCDate()!==d||y<2020||y>2100)return null;return `${a[3]}-${a[2]}-${a[1]}`;}
export function parseSavingsGoal(message,defaultCurrency='RUB'){
 const text=String(message||'').trim().replace(/[«»“”"]/g,'');
 if(text.length>240||/[?？]/.test(text)||/\b(?:не|отмени|отменить|удали|удалить)\s+(?:создавай|добавляй|создай|цель|накоп)/iu.test(text))return null;
 const match=goalRE.exec(text);if(!match)return null;
 const value=Number(match[1].replace(/[\s\u00a0]/g,'').replace(',','.'));
 if(!Number.isFinite(value)||value<=0||value>1e9||Math.round(value*100)!==value*100)return null;
 const currency=curMap.get(normalize(match[2]))||defaultCurrency;
 if(!['KGS','RUB','USD','EUR','KZT'].includes(currency))return null;
 const deadline=match[3]?isoDate(match[3]):null;
 if(match[3]&&!deadline)return null;
 return {name:`Накопить ${value.toLocaleString('ru-RU')} ${currency}`,target:value,saved:0,currency,deadline};
}
function isFollowup(s){return /^(?:создать|создай|добавить|добавь|да,?\s*создай|да,?\s*добавь)[.!]?$/iu.test(String(s||'').trim());}
export function resolveSavingsGoal(text,history=[],defaultCurrency='RUB',now=Date.now()){
 const direct=parseSavingsGoal(text,defaultCurrency);
 if(direct)return direct;
 if(!isFollowup(text))return null;
 for(const entry of history.slice(-14).reverse()){
  if(entry.role!=='user')continue;
  const time=Date.parse(entry.created_at||'');
  if(!Number.isFinite(time)||now-time>10*60_000||time>now+60_000)return null;
  return parseSavingsGoal(entry.content||entry.text,defaultCurrency);
 }
 return null;
}
export async function applySavingsGoal({pool,user,key,goal}){
 if(!pool||!user?.id||!key||!goal)throw new Error('Trusted session and goal required');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const existing=await client.query('SELECT result FROM agent_action_log WHERE user_id=$1 AND action_key=$2',[user.id,key]);
  if(existing.rowCount){await client.query('COMMIT');return {...existing.rows[0].result,duplicate:true};}
  const locked=await client.query("SELECT payload,revision FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  let result;
  const doc=locked.rows[0];
  if(!doc){result={changed:false,text:'Финансы ещё не подключены. Открой раздел «Финансы» в SkillUp.'};}
  else if(doc.payload?.savingsGoal){
   const g=doc.payload.savingsGoal;
   if(Number(g.target)===goal.target && (g.currency||'RUB')===goal.currency && g.deadline===goal.deadline){
    result={changed:false,text:'Такая цель накоплений уже существует. Повторно не добавлял.'};
   }else result={changed:false,text:'Цель накоплений уже существует. Напиши, что изменить в ней, — текущую я не перезаписывал.'};
  }else{
   const updated={...doc.payload,savingsGoal:goal};
   await client.query("UPDATE user_documents SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='finances'",[user.id,'finances',JSON.stringify(updated)]);
   result={changed:true,domain:'finances',text:`Создал цель накоплений: ${goal.target.toLocaleString('ru-RU')} ${goal.currency}${goal.deadline?' до '+goal.deadline.split('-').reverse().join('.'):''}.`};
  }
  await client.query('INSERT INTO agent_action_log(user_id,action_key,kind,before_payload,after_revision,result,changed) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)',[user.id,key,result.changed?'finances':null,result.changed?JSON.stringify(doc.payload):null,result.changed?Number(doc.revision)+1:null,JSON.stringify(result),result.changed]);
  await client.query('COMMIT');return result;
 }catch(err){await client.query('ROLLBACK').catch(()=>{});throw err;}finally{client.release();}
}
