import crypto from 'node:crypto';

// Deterministic, audited mutations. The LLM is not trusted with SQL or user_id.
const clean = s => String(s ?? '').trim();
const nrm = s => clean(s).toLocaleLowerCase('ru-RU');
const amount = s => {
  const value = Number(clean(s).replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 1_000_000_000 && Math.round(value*100)===value*100 ? value : null;
};
function quote(s){return clean(s).replace(/^[«"'“]+|[»"'”]+$/g,'').trim();}

export function parseAgentAction(input){
 const t=clean(input);
 if(!t||t.length>350||/[?？]/u.test(t)||/\bне\s+(?:изменяй|меняй|создавай|добавляй|переименовывай|переименуй|удаляй|исправляй)\b/iu.test(t))return null;
 if(/^(?:отмени|отменить)\s+(?:последнее\s+)?(?:изменение|редактирование)(?:\s+в\s+skillup)?[.!]?$/iu.test(t))return {type:'undo'};
 let m=/^(?:переименуй|переименовать|измени название)\s+(цель|навык|привычку|направление)\s+(.+?)\s+(?:в|на)\s+(.+)$/iu.exec(t);
 if(m)return {type:'rename',kind:({цель:'goal',навык:'skill',привычку:'habit',направление:'area'})[nrm(m[1])],oldName:quote(m[2]),newName:quote(m[3])};
 m=/^(?:добавь|создай)\s+(цель|навык|привычку|направление)\s+(.+)$/iu.exec(t);
 if(m)return {type:'create',kind:({цель:'goal',навык:'skill',привычку:'habit',направление:'area'})[nrm(m[1])],title:quote(m[2])};
 m=/^(?:поставь|измени|исправь|поменяй)\s+(?:сумму|цену)\s+(?:последн(?:его|ей)\s+)?(?:расхода|покупки|операции|транзакции)\s+(?:на|в)\s+([\d\s.,]+)(?:\s*(сом(?:ов|а)?|руб(?:лей|ля|ль)?|доллар(?:ов|а)?|kgs|rub|usd|₽|\$))?$/iu.exec(t);
 if(m)return {type:'finance_amount',value:amount(m[1]),currency:clean(m[2])||null,expenseOnly:/расхода|покупки/iu.test(t)};
 m=/^(?:перенеси|измени|поменяй|исправь)\s+дату\s+(?:последн(?:его|ей)\s+)?(?:расхода|покупки|операции|транзакции)\s+(?:на\s+)?(вчера|сегодня|\d{2}\.\d{2}\.\d{4})$/iu.exec(t);
 if(m)return {type:'finance_date',value:nrm(m[1]),expenseOnly:/расхода|покупки/iu.test(t)};
 m=/^(?:измени|поменяй|исправь)\s+категорию\s+(?:последн(?:его|ей)\s+)?(?:расхода|покупки|операции|транзакции)\s+(?:на|в)\s+(.+)$/iu.exec(t);
 if(m)return {type:'finance_category',value:quote(m[1]),expenseOnly:/расхода|покупки/iu.test(t)};
 m=/^(?:измени|поменяй|исправь)\s+(?:описание|название|комментарий)\s+(?:последн(?:его|ей)\s+)?(?:расхода|покупки|операции|транзакции)\s+(?:на|в)\s+(.+)$/iu.exec(t);
 if(m)return {type:'finance_note',value:quote(m[1]),expenseOnly:/расхода|покупки/iu.test(t)};
 return null;
}
function fail(message){return {handled:true,text:message,changed:false};}
function succeed(message){return {handled:true,text:message,changed:true};}
function validName(s){return typeof s==='string'&&s.length>=2&&s.length<=110&&!/[\r\n<>]/.test(s);}
function userDate(s,tz){
 // Using Intl for user's local calendar day; never derive yesterday by subtracting 86400000 ms from an instant.
 const zone=typeof tz==='string'&&tz.length<=80?tz:'Asia/Bishkek';
 let parts;
 try {parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));}
 catch{return null;}
 let yyyy=Number(parts.year),mm=Number(parts.month),dd=Number(parts.day);
 if(s==='вчера'){
  const day=new Date(Date.UTC(yyyy,mm-1,dd));day.setUTCDate(day.getUTCDate()-1);
  yyyy=day.getUTCFullYear();mm=day.getUTCMonth()+1;dd=day.getUTCDate();
 } else if(s!=='сегодня'){
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);if(!m)return null;
  dd=+m[1];mm=+m[2];yyyy=+m[3];
 }
 const check=new Date(Date.UTC(yyyy,mm-1,dd));
 if(check.getUTCFullYear()!==yyyy||check.getUTCMonth()+1!==mm||check.getUTCDate()!==dd||yyyy<2020||yyyy>2100)return null;
 // Date-only is stored as an ISO day at noon UTC to avoid DST date drift in common views.
 return `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T12:00:00.000Z`;
}
async function lockedDoc(client,userId,kind){
 const r=await client.query('SELECT payload,revision FROM user_documents WHERE user_id=$1 AND kind=$2 FOR UPDATE',[userId,kind]);
 return r.rowCount?r.rows[0]:null;
}
async function saveDoc(client,userId,kind,payload,existing){
 if(existing)await client.query('UPDATE user_documents SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind=$2',[userId,kind,JSON.stringify(payload)]);
 else await client.query('INSERT INTO user_documents(user_id,kind,payload) VALUES($1,$2,$3::jsonb)',[userId,kind,JSON.stringify(payload)]);
}
function chooseFinance(entries,expenseOnly=false){
 if(!Array.isArray(entries)||!entries.length)return {error:'Не нашёл операций для редактирования.'};
 const ordered=entries.map((e,i)=>({e,i})).filter(x=>x.e&&(expenseOnly?x.e.type==='Расход':['Расход','Доход'].includes(x.e.type))).sort((a,b)=>new Date(b.e.date||0)-new Date(a.e.date||0));
 if(!ordered.length)return {error:'Не нашёл операций для редактирования.'};
 if(ordered.length>1&&Number.isFinite(Date.parse(ordered[0].e.date))&&new Date(ordered[0].e.date).getTime()===new Date(ordered[1].e.date).getTime())return {error:'Есть несколько операций с одинаковым временем. Уточни, какую изменить.'};
 return ordered[0];
}
function currencyCode(raw){if(!raw)return null;const t=nrm(raw);return /^(сом|сома|сомов|kgs)$/.test(t)?'KGS':/^(руб|рубль|рубля|рублей|₽|rub)$/.test(t)?'RUB':/^(доллар|доллара|долларов|usd|\$)$/.test(t)?'USD':null;}

export async function executeAgentAction(pool,user,text,{key,timezone='Asia/Bishkek'}={}){
 const cmd=parseAgentAction(text);if(!cmd)return null;
 if(!user?.id||!key||!/^.{1,130}$/.test(String(key)))throw new Error('Missing authenticated user or idempotency key');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const prior=await c.query('SELECT result FROM agent_action_log WHERE user_id=$1 AND action_key=$2',[user.id,key]);
  if(prior.rowCount){await c.query('COMMIT');return {...prior.rows[0].result,duplicate:true};}
  let result, kind, before, after, revision;
  if(cmd.type==='undo'){
   const recent=await c.query("SELECT id,kind,before_payload,after_revision FROM agent_action_log WHERE user_id=$1 AND state='applied' AND changed=true AND created_at>now()-interval '30 days' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[user.id]);
   if(!recent.rowCount)result=fail('Нет изменений за последние 30 дней, которые можно отменить.');
   else{
    const a=recent.rows[0];const doc=await lockedDoc(c,user.id,a.kind);
    if(!doc||Number(doc.revision)!==Number(a.after_revision))result=fail('После этого действия данные уже изменились. Автоматическая отмена остановлена, чтобы не потерять новые записи.');
    else {
     await saveDoc(c,user.id,a.kind,a.before_payload,doc);
     await c.query("UPDATE agent_action_log SET state='undone',undone_at=now() WHERE id=$1",[a.id]);
     result=succeed('Отменил последнее изменение. Остальные записи не затронуты.');
    }
   }
  } else if(cmd.type.startsWith('finance_')){
   kind='finances';const doc=await lockedDoc(c,user.id,kind);
   if(!Array.isArray(doc?.payload?.entries))result=fail('Финансовых записей пока нет.');
   else{
    const choice=chooseFinance(doc.payload.entries,cmd.expenseOnly);
    if(choice.error)result=fail(choice.error);
    else{
     const next=structuredClone(doc.payload);const entry=next.entries[choice.i];let textResult='';
     if(cmd.type==='finance_amount'){
      if(cmd.value===null)result=fail('Не смог определить корректную сумму.');
      else{
       const cur=currencyCode(cmd.currency);
       if(cmd.currency&&!cur)result=fail('Не распознал валюту, запись не менял.');
       else{entry.amount=cmd.value;if(cur)entry.currency=cur;textResult=`Изменил сумму последней операции на ${cmd.value.toLocaleString('ru-RU')} ${cur||entry.currency||'RUB'}.`;}
      }
     }else if(cmd.type==='finance_date'){
      const value=userDate(cmd.value,timezone);
      if(!value)result=fail('Дата не распознана. Используй «вчера» или ДД.ММ.ГГГГ.');
      else{entry.date=value;textResult=`Изменил дату операции на ${value.slice(0,10)}.`;}
     }else if(cmd.type==='finance_category'){
      if(!validName(cmd.value))result=fail('Название категории должно содержать от 2 до 110 символов.');
      else{entry.category=cmd.value;textResult=`Изменил категорию на «${cmd.value}».`;}
     }else if(cmd.type==='finance_note'){
      if(!cmd.value||cmd.value.length>250)result=fail('Описание должно содержать от 1 до 250 символов.');
      else{entry.note=cmd.value;textResult='Обновил описание последней операции.';}
     }
     if(!result){before=doc.payload;after=next;revision=Number(doc.revision)+1;await saveDoc(c,user.id,kind,after,doc);result=succeed(textResult);}
    }
   }
  } else {
   kind='development';const doc=await lockedDoc(c,user.id,kind);
   if(!doc)result=fail('Раздел «Развитие» ещё не создан. Открой его один раз в приложении.');
   else{
    const next=structuredClone(doc.payload);
    if(!Array.isArray(next.items))next.items=[];
    if(!Array.isArray(next.areas))next.areas=[];
    if(cmd.type==='rename'){
     if(!validName(cmd.oldName)||!validName(cmd.newName))result=fail('Уточни старое и новое название.');
     else{
      const list=cmd.kind==='area'?next.areas:next.items.filter(x=>x.kind===cmd.kind);
      const found=list.filter(x=>nrm(x.name||x.title)===nrm(cmd.oldName));
      if(found.length!==1)result=fail(found.length?'Найдено несколько совпадений. Уточни объект.':'Не нашёл объект с таким названием.');
      else {if(cmd.kind==='area')found[0].name=cmd.newName;else found[0].title=cmd.newName;result=succeed(`Переименовал в «${cmd.newName}». Этапы и отметки сохранены.`);}
     }
    }else if(cmd.type==='create'){
     if(!validName(cmd.title))result=fail('Укажи название длиной от 2 до 110 символов.');
     else if(cmd.kind==='area'){
      if(next.areas.some(x=>nrm(x.name)===nrm(cmd.title)))result=fail('Такое направление уже есть.');
      else{next.areas.push({id:crypto.randomUUID(),name:cmd.title,icon:'◉'});result=succeed(`Создал направление «${cmd.title}».`);}
     }else if(next.areas.length!==1)result=fail('Укажи направление в «Развитии»: сейчас их несколько или ни одного. Цель пока не создавал.');
     else{
      const id=crypto.randomUUID();next.items.push({id,areaId:next.areas[0].id,kind:cmd.kind,title:cmd.title,description:'',paused:false,steps:[],actions:[],completed:{},actionCompleted:{}});
      result=succeed(`Создал ${cmd.kind==='goal'?'цель':cmd.kind==='skill'?'навык':'привычку'} «${cmd.title}». Можно добавить этапы и расписание.`);
     }
    }
    if(result?.changed){before=doc.payload;after=next;revision=Number(doc.revision)+1;await saveDoc(c,user.id,kind,after,doc);}
   }
  }
  await c.query(`INSERT INTO agent_action_log(user_id,action_key,kind,before_payload,after_revision,result,changed)
   VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)`,[user.id,key,result.changed&&kind?kind:null,before?JSON.stringify(before):null,revision||null,JSON.stringify(result),result.changed&&!!before]);
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
