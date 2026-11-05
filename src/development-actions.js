import crypto from 'node:crypto';

// Only direct imperative commands trigger changes. Quotes in a conversational question
// or a negative instruction must never become deletion.
export function parseDevelopmentCommand(text){
  const raw=String(text||'').trim();
  if(!raw || raw.length>300 || /[?？]/u.test(raw))return null;
  const s=raw.replace(/^(?:слушай[,!]?\s+)?(?:друг[,!]?\s+)?(?:пожалуйста[,!]?\s+)?/iu,'').trim();
  if(/(?:^|\s)не\s+(?:удаляй|удали|убирай|сотри)/iu.test(s))return null;
  if(/^(?:подтверждаю\s+удаление(?:\s+всех\s+целей)?|да,?\s+удали\s+все\s+цели)[.!]?$/iu.test(s))return {action:'confirm'};
  if(/^(?:верни|восстанови)\s+(?:мои\s+|все\s+|последние\s+)?(?:удал[её]нные\s+)?цел(?:и|ь)[.!]?$/iu.test(s))return {action:'restore'};
  const m=/^(?:удали|удалите|убери|сотри)\s+(.*)$/iu.exec(s);
  if(!m)return null;
  let target=m[1].trim().replace(/[.!]+$/u,'');
  // 'цели' plural explicitly means all goals, never skills or habits.
  if(/^(?:(?:все|мои|эти|тестовые|все мои)\s+)*цели(?=\s|$|[,!.])/iu.test(target)||/^(?:все\s+)?цели\s+(?:для\s+теста|они\s+были\s+для\s+теста)/iu.test(target))return {action:'all'};
  const one=/^(?:мою\s+)?цель\s+(.+)$/iu.exec(target);
  if(!one)return null;
  const title=one[1].replace(/^[«"'\s]+|[»"'\s]+$/gu,'').trim();
  return title && title.length<=110 ? {action:'one',title} : null;
}
const answer=x=>({handled:true,...x});
const norm=s=>String(s||'').trim().toLocaleLowerCase('ru-RU');
async function withTx(pool,callback){
 const c=await pool.connect();
 try {await c.query('BEGIN');const result=await callback(c);await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally {c.release();}
}
async function lockedDoc(c,userId){
 const r=await c.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development' FOR UPDATE",[userId]);
 return r.rowCount?r.rows[0].payload:null;
}
async function writeDoc(c,userId,doc){
 await c.query("UPDATE user_documents SET payload=$2::jsonb, revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='development'",[userId,JSON.stringify(doc)]);
}
const goals=doc=>(Array.isArray(doc?.items)?doc.items:[]).filter(x=>x?.kind==='goal');
const previewNames=entries=>entries.slice(0,7).map(x=>String(x.title||'Без названия').slice(0,80)).join(', ');
export async function requestDeleteGoals(pool,user){
 const r=await pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development'",[user.id]);
 const selected=goals(r.rows[0]?.payload);
 if(!selected.length)return answer({text:'Целей для удаления нет.'});
 const ids=selected.map(x=>({id:String(x.id),title:String(x.title||'')}));
 const requestId=crypto.randomUUID();
 await pool.query(`INSERT INTO development_delete_pending(user_id,request_id,items,expires_at)
  VALUES($1,$2,$3::jsonb,now()+interval '10 minutes') ON CONFLICT(user_id)
  DO UPDATE SET request_id=EXCLUDED.request_id,items=EXCLUDED.items,expires_at=EXCLUDED.expires_at`,[user.id,requestId,JSON.stringify(ids)]);
 return answer({text:`Найдено ${selected.length} целей: ${previewNames(selected)}. Удалить их все? Это можно будет отменить в течение 30 дней.`,pending:{id:requestId,count:selected.length}});
}
export async function confirmDeleteGoals(pool,user,requestId=null){
 return withTx(pool,async c=>{
  const pending=await c.query('SELECT request_id,items,expires_at FROM development_delete_pending WHERE user_id=$1 FOR UPDATE',[user.id]);
  if(!pending.rowCount||pending.rows[0].expires_at<=new Date()||(requestId&&String(pending.rows[0].request_id)!==String(requestId)))return answer({text:'Запрос на удаление не найден или срок подтверждения истёк. Повтори команду.'});
  const doc=await lockedDoc(c,user.id);
  if(!Array.isArray(doc?.items))return answer({text:'Сейчас нет целей для удаления.'});
  const chosen=pending.rows[0].items;
  if(!Array.isArray(chosen)||!chosen.length||chosen.length>120)return answer({text:'Некорректный запрос удаления.'});
  const target=new Map(chosen.map(x=>[String(x.id),String(x.title)]));
  const snapshots=[];
  doc.items.forEach((item,index)=>{if(item?.kind==='goal'&&target.get(String(item.id))===String(item.title))snapshots.push({index,item});});
  if(snapshots.length!==target.size)return answer({text:'Список целей изменился. Повтори удаление, чтобы проверить его заново.'});
  const ids=new Set(snapshots.map(x=>String(x.item.id)));
  await writeDoc(c,user.id,{...doc,items:doc.items.filter(x=>!ids.has(String(x?.id)))});
  const archive=crypto.randomUUID();
  await c.query("INSERT INTO development_action_history(id,user_id,deleted_items) VALUES($1,$2,$3::jsonb)",[archive,user.id,JSON.stringify(snapshots)]);
  await c.query('DELETE FROM development_delete_pending WHERE user_id=$1',[user.id]);
  return answer({text:`Удалил ${snapshots.length} целей. История сохранена для восстановления в течение 30 дней.`,deleted:snapshots.length,archiveId:archive});
 });
}
export async function cancelPendingDelete(pool,user,requestId){
 const r=await pool.query('DELETE FROM development_delete_pending WHERE user_id=$1 AND request_id=$2',[user.id,requestId]);
 return answer({text:r.rowCount?'Удаление отменено.':'Запрос уже отменён или истёк.'});
}
export async function deleteOneGoal(pool,user,title){
 return withTx(pool,async c=>{
  const doc=await lockedDoc(c,user.id);
  if(!Array.isArray(doc?.items))return answer({text:'У тебя пока нет сохранённых целей.'});
  const candidates=[];
  doc.items.forEach((item,index)=>{if(item?.kind==='goal'&&norm(item.title)===norm(title))candidates.push({index,item});});
  if(!candidates.length)return answer({text:`Цель «${title}» не найдена. Напиши точное название.`});
  if(candidates.length>1)return answer({text:`Есть ${candidates.length} целей с таким названием. Уточни, какую удалить в разделе «Развитие».`});
  const selected=candidates[0];
  await writeDoc(c,user.id,{...doc,items:doc.items.filter((_,i)=>i!==selected.index)});
  const archiveId=crypto.randomUUID();
  await c.query('INSERT INTO development_action_history(id,user_id,deleted_items) VALUES($1,$2,$3::jsonb)',[archiveId,user.id,JSON.stringify([selected])]);
  return answer({text:`Удалил цель «${selected.item.title}». Можно восстановить в течение 30 дней.`,deleted:1,archiveId});
 });
}
export async function restoreGoals(pool,user,archiveId=null){
 return withTx(pool,async c=>{
  const history=await c.query(`SELECT id,deleted_items FROM development_action_history WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2::uuid)
    AND state='deleted' AND created_at>now()-interval '30 days'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[user.id,archiveId]);
  if(!history.rowCount)return answer({text:'Нет удалённых за последние 30 дней целей для восстановления.'});
  const doc=await lockedDoc(c,user.id);
  if(!Array.isArray(doc?.items))return answer({text:'Не удалось открыть список целей.'});
  const snapshots=history.rows[0].deleted_items;
  const ids=new Set(doc.items.map(x=>String(x?.id)));
  if(!Array.isArray(snapshots)||snapshots.some(x=>!x?.item?.id||ids.has(String(x.item.id))))return answer({text:'Некоторые цели уже существуют. Восстановление остановлено, чтобы не создать дубликаты.'});
  const next=doc.items.slice();
  for(const snap of [...snapshots].sort((a,b)=>a.index-b.index))next.splice(Math.max(0,Math.min(snap.index,next.length)),0,snap.item);
  await writeDoc(c,user.id,{...doc,items:next});
  await c.query("UPDATE development_action_history SET state='restored',restored_at=now() WHERE id=$1 AND user_id=$2",[history.rows[0].id,user.id]);
  return answer({text:`Восстановил ${snapshots.length} целей вместе с этапами и отметками.`,restored:snapshots.length});
 });
}
export async function handleDevelopmentText(pool,user,text){
 const intent=parseDevelopmentCommand(text);
 if(!intent)return null;
 if(intent.action==='all')return requestDeleteGoals(pool,user);
 if(intent.action==='one')return deleteOneGoal(pool,user,intent.title);
 if(intent.action==='confirm')return confirmDeleteGoals(pool,user);
 if(intent.action==='restore')return restoreGoals(pool,user);
 return null;
}
