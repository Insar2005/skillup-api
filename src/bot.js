import {dispatchSkillUpAction} from './agent-dispatch.js';
import {executeAgentAction} from './agent-actions.js';
import {parseFinanceIntent,appendFinance,financeReply,undoFinanceExternal,restoreFinanceExternal,restoreLastFinance,financeCorrectionIntent,restoredFinanceReply} from './ai-finance.js';
import {inspectReceiptMedia,saveReceiptDraft,commitReceiptDraft,undoReceiptDraft} from './ai-media.js';
import crypto from 'node:crypto';
import {generateAgentAnswer,validateInputMessage} from './ai.js';
import {classifyFinance,EXPENSE_CATEGORIES,INCOME_CATEGORIES} from './bot-finance.js';
import {enrichFinanceCategory} from './category.js';
import {handleDevelopmentText,confirmDeleteGoals,cancelPendingDelete,restoreGoals} from './development-actions.js';

const API='https://api.telegram.org/bot';
const headers={ 'content-type':'application/json' };
const fmt=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₽';
let busy=false;
function isPrivate(msg){return msg?.chat?.type==='private' && msg.chat.id===msg.from?.id && Number.isSafeInteger(msg.from.id);}
export function validWebhookSecret(got,expected){if(!expected||!got||typeof got!=='string'||typeof expected!=='string')return false;const a=Buffer.from(got),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
export async function telegram(method,data){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const r=await fetch(`${API}${token}/${method}`,{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
  const body=await r.json().catch(()=>({}));
  if(!r.ok||!body.ok)throw new Error(`Telegram ${method}: HTTP ${r.status}`);
  return body.result;
}
// Telegram Bot API chat actions expire after about five seconds. Keep the real
// activity indicator alive while the queued update is being processed.
export async function withTelegramActivity(chatId, action, operation, sender=telegram){
  if(typeof operation!=='function')throw new TypeError('operation required');
  const valid=new Set(['typing','upload_photo','upload_document','upload_voice','record_voice']);
  if(!valid.has(action))throw new Error('Unsupported Telegram chat action');
  let active=true;
  const notify=()=>{
    try{Promise.resolve(sender('sendChatAction',{chat_id:chatId,action})).catch(()=>{});}catch{}
  };
  notify();
  const timer=setInterval(()=>{if(active)notify();},4000);
  timer.unref?.();
  try{return await operation();}
  finally{active=false;clearInterval(timer);}
}

async function say(chat_id,text,extra={}){
  // Do not truncate replies in the middle of a sentence. Normal replies are short;
  // explicit long reports are split at paragraph / sentence / whitespace boundaries.
  let rest=String(text||'').trim();let last;
  while(rest){
    if(rest.length<=3500){last=await telegram('sendMessage',{chat_id,text:rest,...extra});break;}
    const fragment=rest.slice(0,3500);
    let cut=Math.max(fragment.lastIndexOf('\n'),fragment.lastIndexOf('. '),fragment.lastIndexOf(' '));
    if(cut<2000)cut=3500;
    last=await telegram('sendMessage',{chat_id,text:fragment.slice(0,cut).trim()});
    rest=rest.slice(cut).trim();
  }
  return last;
}
async function ensureUser(pool,tg){
  const r=await pool.query(`INSERT INTO users (telegram_id,first_name,last_name,username,language_code)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(telegram_id) DO UPDATE SET
    first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,updated_at=now()
    RETURNING id,telegram_id,preferred_currency`,[tg.id,tg.first_name||null,tg.last_name||null,tg.username||null,tg.language_code||null]);
  return r.rows[0];
}
async function fileToText(fileId){
  const file=await telegram('getFile',{file_id:fileId});
  if(typeof file?.file_path!=='string'||!/^voice\//.test(file.file_path))throw new Error('Unexpected voice file path');
  const url=`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('Voice download failed');
  const bytes=await r.arrayBuffer();
  if(bytes.byteLength>20_000_000)throw new Error('Voice too large');
  const form=new FormData();
  form.append('file',new Blob([bytes],{type:'audio/ogg'}),'telegram-voice.ogg');
  form.append('model',process.env.TRANSCRIPTION_MODEL||'whisper-1');
  if((process.env.TRANSCRIPTION_MODEL||'whisper-1')==='whisper-1')form.append('language','ru');
  const t=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form,signal:AbortSignal.timeout(45000)});
  const result=await t.json().catch(()=>({}));
  if(!t.ok||typeof result.text!=='string')throw new Error(`Transcription: HTTP ${t.status}`);
  return result.text.trim().slice(0,1500);
}
const kb=(draft,kind,opts)=>({inline_keyboard:opts.map((o,i)=>[{text:o,callback_data:`f:${kind}:${draft.id}:${i}`}])});
async function prepareFinance(pool,user,chat,text,finance){
  if(finance.unsupportedCurrency){await say(chat,'Пока SkillUp учитывает операции в рублях (₽). Сумму в другой валюте автоматически не записываю.');return;}
  if(finance.needAmount){await say(chat,'Укажи сумму, например: «Потратил 1 250 рублей на продукты».');return;}
  const id=crypto.randomUUID();
  await pool.query('INSERT INTO bot_finance_drafts(id,user_id,chat_id,direction,amount,category,note) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,user.id,chat,finance.direction,finance.amount,finance.category,finance.note]);
  if(!finance.category){await say(chat,`Расход ${fmt(finance.amount)}. Выбери категорию:`,{reply_markup:kb({id},'cat',EXPENSE_CATEGORIES)});return;}
  await showDraft(chat,{id,...finance});
}
async function showDraft(chat,d){
  await say(chat,`Проверим запись:\n${d.direction==='income'?'Доход':'Расход'}: ${fmt(d.amount)}\nКатегория: ${d.category}\nКомментарий: ${String(d.note||'').slice(0,150)}\n\nСохранить в SkillUp?`,{
    reply_markup:{inline_keyboard:[[{'text':'✅ Сохранить','callback_data':`f:ok:${d.id}:0`},{'text':'❌ Отмена','callback_data':`f:no:${d.id}:0`}]]}
  });
}
async function commitFinance(pool,user,draftId){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const d=await client.query('SELECT * FROM bot_finance_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE',[draftId,user.id]);
    if(!d.rowCount){await client.query('ROLLBACK');return 'not_found';}
    const row=d.rows[0];
    if(row.status==='committed'){await client.query('ROLLBACK');return 'already';}
    if(row.status!=='pending'||new Date(row.expires_at)<new Date()||!row.category){await client.query('ROLLBACK');return 'expired';}
    const existing=await client.query("SELECT payload,revision FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
    let payload=existing.rows[0]?.payload||{entries:[],savingsGoal:null};
    if(!Array.isArray(payload.entries))throw new Error('Invalid finance document shape');
    if(payload.entries.length>=500){await client.query('ROLLBACK');return 'limit';}
    const entry={type:row.direction==='income'?'Доход':'Расход',category:row.category,amount:Number(row.amount),note:row.note||'',date:new Date().toISOString(),externalId:`bot:${row.id}`};
    if(!payload.entries.some(e=>e.externalId===entry.externalId))payload={...payload,entries:[entry,...payload.entries]};
    if(existing.rowCount){await client.query("UPDATE user_documents SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind=$2",[user.id,'finances',JSON.stringify(payload)]);}
    else {await client.query("INSERT INTO user_documents(user_id,kind,payload) VALUES($1,'finances',$2::jsonb)",[user.id,JSON.stringify(payload)]);}
    await client.query("UPDATE bot_finance_drafts SET status='committed' WHERE id=$1",[row.id]);
    await client.query('COMMIT');return 'saved';
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
async function callback(pool,update){
  const cb=update.callback_query;if(!cb?.from?.id||cb.message?.chat?.type!=='private'||cb.message.chat.id!==cb.from.id)return;
  const devMatch=/^dg:(ok|no|restore):([0-9a-f-]{36})$/.exec(cb.data||'');
  if(devMatch){
    const user=await ensureUser(pool,cb.from);
    const action=devMatch[1]==='ok'?await confirmDeleteGoals(pool,user,devMatch[2]):
      devMatch[1]==='no'?await cancelPendingDelete(pool,user,devMatch[2]):await restoreGoals(pool,user,devMatch[2]);
    await telegram('answerCallbackQuery',{callback_query_id:cb.id,text:action.text.slice(0,180)});
    await recordBotChat(pool,user,update.update_id,'Действие с целями',action.text);
    await say(cb.message.chat.id,action.text,action.archiveId?{reply_markup:{inline_keyboard:[[{text:'↷ Восстановить цели',callback_data:`dg:restore:${action.archiveId}`}]]}}:{});
    return;
  }
  const undoMatch=/^u:(\d{1,20})$/.exec(cb.data||'');
  if(undoMatch){
    const user=await ensureUser(pool,cb.from);
    const ok=await undoFinanceExternal(pool,user,`bot:${undoMatch[1]}:0`);
    const msg=ok?'Отменил операцию. Чтобы восстановить, нажми «Вернуть» или напиши «Верни».':'Эта операция уже отменена или не найдена.';
    await telegram('answerCallbackQuery',{callback_query_id:cb.id,text:msg.slice(0,190)});
    if(ok){
      await recordBotChat(pool,user,update.update_id,'Отменить операцию',msg);
      await say(cb.message.chat.id,msg,{reply_markup:{inline_keyboard:[[{text:'↷ Вернуть',callback_data:`re:${undoMatch[1]}`}]]}});
    }
    return;
  }
  const redoMatch=/^re:(\d{1,20})$/.exec(cb.data||'');
  if(redoMatch){
    const user=await ensureUser(pool,cb.from);
    const restored=await restoreFinanceExternal(pool,user,`bot:${redoMatch[1]}:0`);
    const msg=restored?restoredFinanceReply(restored.entry):'Операция уже восстановлена или не найдена.';
    await telegram('answerCallbackQuery',{callback_query_id:cb.id,text:msg.slice(0,190)});
    if(restored){
      await recordBotChat(pool,user,update.update_id,'Вернуть операцию',msg);
      await say(cb.message.chat.id,msg,{reply_markup:{inline_keyboard:[[{text:'↶ Отменить',callback_data:`u:${redoMatch[1]}`}]]}});
    }
    return;
  }
  const receiptMatch=/^r:(ok|undo):([0-9a-f-]{36})$/.exec(cb.data||'');
  if(receiptMatch){
    const user=await ensureUser(pool,cb.from);
    const result=receiptMatch[1]==='ok'?await commitReceiptDraft(pool,user,receiptMatch[2],user.preferred_currency||'RUB'):{saved:await undoReceiptDraft(pool,user,receiptMatch[2])};
    const msg=receiptMatch[1]==='ok'?(result.saved?'Чек добавлен в Финансы.':result.message||'Не удалось записать чек.'):(result.saved?'Записи этого чека удалены.':'Чек уже отменён или не найден.');
    await telegram('answerCallbackQuery',{callback_query_id:cb.id,text:msg.slice(0,190)});
    await say(cb.message.chat.id,msg,receiptMatch[1]==='ok'&&result.saved?{reply_markup:{inline_keyboard:[[{text:'↶ Отменить чек',callback_data:`r:undo:${receiptMatch[2]}`}]]}}:{});
    return;
  }
  const m=/^f:(ok|no|cat):([0-9a-f-]{36}):(\d)$/.exec(cb.data||'');
  if(!m)return;
  const user=await ensureUser(pool,cb.from);
  const data=await pool.query('SELECT * FROM bot_finance_drafts WHERE id=$1 AND user_id=$2',[m[2],user.id]);
  let answer='Операция не найдена или устарела.';
  if(data.rowCount){const d=data.rows[0];
    if(d.status!=='pending'||new Date(d.expires_at)<new Date())answer='Эта операция уже обработана или срок подтверждения истёк.';
    else if(m[1]==='no') {await pool.query("UPDATE bot_finance_drafts SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending'",[d.id,user.id]);answer='Запись отменена.';}
    else if(m[1]==='cat'){
      const category=(d.direction==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES)[Number(m[3])];
      if(category){await pool.query("UPDATE bot_finance_drafts SET category=$3 WHERE id=$1 AND user_id=$2 AND status='pending'",[d.id,user.id,category]);await showDraft(d.chat_id,{...d,category});answer='Категория выбрана.';}
    }else if(m[1]==='ok'){
      const status=await commitFinance(pool,user,d.id);
      answer=status==='saved'?'✅ Операция сохранена в PostgreSQL. Открой или обнови раздел «Финансы» в SkillUp.':status==='already'?'Уже сохранено.':status==='limit'?'Достигнут лимит операций в документе.':'Не удалось сохранить: проверь срок или категорию.';
    }
  }
  await telegram('answerCallbackQuery',{callback_query_id:cb.id,text:answer.slice(0,200),show_alert:m[1]==='ok'});
  if(m[1]==='ok'||m[1]==='no')await say(cb.message.chat.id,answer);
}
async function chatWithClaude(pool,user,chat,text,updateId){
  if(!(process.env.AI_PROVIDER==='openai'?process.env.OPENAI_API_KEY:process.env.ANTHROPIC_API_KEY)){await say(chat,'ИИ временно недоступен.');return;}
  if(!validateInputMessage(text)){await say(chat,'Сообщение слишком длинное. Напиши короче (до 1500 символов).');return;}
  const reqId=crypto.randomUUID();
  const [hist,dev]=await Promise.all([
    pool.query('SELECT role,content,created_at FROM ai_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 14',[user.id]),
    pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development'",[user.id])
  ]);
  const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),45000);
  let answer;
  try{answer=await generateAgentAnswer({message:text,history:hist.rows.reverse(),development:dev.rows[0]?.payload||{areas:[],items:[]},timezone:process.env.DEFAULT_TIMEZONE||'Asia/Bishkek',signal:ctrl.signal,pool,user,key:`bot:${updateId}`});}
  finally{clearTimeout(timeout);}
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES($1,$2,$3,$4)',[user.id,'user',text,reqId]);
    await client.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES($1,$2,$3,$4)',[user.id,'assistant',answer,reqId]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const financeSaved=await pool.query("SELECT 1 FROM finance_action_history WHERE user_id=$1 AND external_id=$2 AND state='active'",[user.id,`bot:${updateId}:0`]);
  await say(chat,answer,financeSaved.rowCount?{reply_markup:{inline_keyboard:[[{text:'↶ Отменить',callback_data:`u:${updateId}`}]]}}:{});
}
async function recordBotChat(pool,user,updateId,text,answer){
 const hex=crypto.createHash('sha256').update('bot:'+updateId).digest('hex');
 const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
 const r=await pool.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[user.id,'user',String(text).slice(0,1500),id]);
 if(r.rowCount)await pool.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES($1,$2,$3,$4)',[user.id,'assistant',String(answer).slice(0,2200),id]);
}
async function handleMediaMessage(pool,user,chat,m,updateId){
 const photo=m.photo?.at(-1);
 const document=m.document;
 if(!photo&&!document)return false;
 if((photo?.file_size||document?.file_size||0)>6*1024*1024){await say(chat,'Файл слишком большой — максимум 6 МБ.');return true;}
 const fileId=photo?.file_id||document?.file_id;
 if(!fileId)return true;
 const info=await telegram('getFile',{file_id:fileId});
 if(typeof info?.file_path!=='string'||!info.file_path||info.file_path.length>512){await say(chat,'Не удалось получить вложение.');return true;}
 const r=await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`,{signal:AbortSignal.timeout(15000)});
 if(!r.ok){await say(chat,'Не удалось скачать вложение из Telegram.');return true;}
 const buffer=Buffer.from(await r.arrayBuffer());
 if(buffer.length>6*1024*1024){await say(chat,'Отправь более компактный файл до 6 МБ.');return true;}
 let type='';
 if(buffer.subarray(0,3).toString('hex')==='ffd8ff')type='image/jpeg';
 else if(buffer.subarray(0,8).toString('hex')==='89504e470d0a1a0a')type='image/png';
 else if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')type='image/webp';
 else if(buffer.subarray(0,5).toString()==='%PDF-')type='application/pdf';
 if(!type){await say(chat,'Можно отправить фото чека (JPG, PNG, WebP) или PDF.');return true;}
 if(!process.env.ANTHROPIC_API_KEY){await say(chat,'Распознавание фото не настроено.');return true;}
 const {output,receipt}=await inspectReceiptMedia(buffer,type,String(m.caption||''));
 if(!receipt){const answer=String(output?.answer||'На фото не удалось разобрать чек.').slice(0,1600);await recordBotChat(pool,user,updateId,'📎 Фото или документ',answer);await say(chat,answer);return true;}
 const id=await saveReceiptDraft(pool,user.id,receipt);
 // One high-confidence, currency-explicit receipt may be saved immediately.
 // Unreconciled items / unknown currency require one action for the whole receipt.
 if(receipt.reconciled&&receipt.currency){
   const result=await commitReceiptDraft(pool,user,id,receipt.currency);
   if(result.saved){const answer=`🧾 Записал ${result.count} операций по чеку: ${receipt.total} ${receipt.currency}.`;await recordBotChat(pool,user,updateId,'📎 Чек',answer);await say(chat,answer,{reply_markup:{inline_keyboard:[[{text:'↶ Отменить чек',callback_data:`r:undo:${id}`}]]}});return true;}
 }
 await recordBotChat(pool,user,updateId,'📎 Чек',`Распознано ${receipt.items.length} позиций на ${receipt.total} ${receipt.currency||user.preferred_currency||'RUB'}.`);
 await say(chat,`🧾 Чек распознан: ${receipt.items.length} позиций, ${receipt.total} ${receipt.currency||user.preferred_currency||'RUB'}. Проверь сумму и добавь весь чек одним нажатием.`,{reply_markup:{inline_keyboard:[[{text:'＋ Добавить все',callback_data:`r:ok:${id}`}]]}});
 return true;
}
async function message(pool,update){
  const m=update.message;if(!isPrivate(m))return;
  const user=await ensureUser(pool,m.from),chat=m.chat.id;
  if(await handleMediaMessage(pool,user,chat,m,update.update_id))return;
  if(m.text==='/start'||m.text==='/help'){await say(chat,'SkillUp — твой помощник по целям и финансам. Напиши вопрос, отправь голосовое или попробуй:\n«Потратил 1250 на продукты»\n«Получил зарплату 45000»\n«Как мой прогресс за 7 дней?»\nПонятные финансовые записи сохраняются сразу; ошибочную операцию можно отменить. Фото чеков принимаю тоже.');return;}
  if(m.text==='/cancel'){await pool.query("UPDATE bot_finance_drafts SET status='cancelled' WHERE user_id=$1 AND status='pending'",[user.id]);await say(chat,'Все неподтверждённые записи отменены.');return;}
  let text=m.text;
  if(m.voice){
    if(!process.env.OPENAI_API_KEY){await say(chat,'Голосовой ввод ещё не настроен: нужен OPENAI_API_KEY в Railway.');return;}
    if(m.voice.duration>120||m.voice.file_size>20_000_000){await say(chat,'Пришли голосовое до 2 минут.');return;}
    text=await fileToText(m.voice.file_id);
    if(!text){await say(chat,'Не удалось разобрать голосовое. Попробуй ещё раз.');return;}
    await say(chat,`🎙 Распознал: ${text}`);
  }
  if(!text)return;
  // v29.9: one AI-first gateway for ordinary messages. Destructive bulk deletion
  // and undo commands remain on the existing deterministic, audited routes.
  const useLegacyGateway=process.env.AGENT_V2!=='true'||/^(?:удали\s+(?:все|всех)|верни|восстанови|отмени)/iu.test(text.trim());
  const protectedText=/^удали\s+все\s+(?:четыре|4)\s+цели[.!]?$/iu.test(text.trim())?'Удали все цели':text;
  const outcome=useLegacyGateway?await dispatchSkillUpAction({pool,user,text:protectedText,key:`bot:${update.update_id}`,timezone:'Asia/Bishkek'}):null;
  if(outcome){
    await recordBotChat(pool,user,update.update_id,text,outcome.answer);
    let extra={};
    if(outcome.kind==='development'){
      const d=outcome;
      if(d.pending)extra={reply_markup:{inline_keyboard:[[{text:`Удалить ${d.pending.count} целей`,callback_data:`dg:ok:${d.pending.id}`},{text:'Оставить',callback_data:`dg:no:${d.pending.id}`}]]}};
      else if(d.archiveId)extra={reply_markup:{inline_keyboard:[[{text:'↷ Восстановить',callback_data:`dg:restore:${d.archiveId}`}]]}};
    }else if(outcome.kind==='finance' && outcome.committed){
      extra={reply_markup:{inline_keyboard:[[{text:'↶ Отменить',callback_data:`u:${update.update_id}`}]]}};
    }else if(outcome.kind==='restore' && outcome.restored){
      const m=/^bot:(\d+):0$/.exec(outcome.restored.externalId);
      if(m)extra={reply_markup:{inline_keyboard:[[{text:'↶ Отменить',callback_data:`u:${m[1]}`}]]}};
    }
    await say(chat,outcome.answer,extra);
    return;
  }
  await chatWithClaude(pool,user,chat,text,update.update_id);
}
export async function acceptTelegramWebhook(req,res,pool){
  const secret=req.headers['x-telegram-bot-api-secret-token'];
  if(!validWebhookSecret(secret,process.env.TELEGRAM_WEBHOOK_SECRET)){res.writeHead(403);res.end();return;}
  let size=0;const chunks=[];
  for await(const c of req){size+=c.length;if(size>300000){res.writeHead(413);res.end();return;}chunks.push(c);}
  let data;
  try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{res.writeHead(400);res.end();return;}
  if(!Number.isSafeInteger(data?.update_id)||(!data.message&&!data.callback_query)){res.writeHead(200);res.end('ok');return;}
  await pool.query('INSERT INTO bot_updates(update_id,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[data.update_id,JSON.stringify(data)]);
  res.writeHead(200,{'content-type':'text/plain'});res.end('ok');
  void processTelegramUpdates(pool);
}
export async function processTelegramUpdates(pool){
  if(busy||!process.env.TELEGRAM_WEBHOOK_SECRET)return;
  busy=true;
  try{
    for(let i=0;i<10;i++){
      const r=await pool.query(`UPDATE bot_updates SET status='working', attempts=attempts+1,started_at=now()
        WHERE update_id=(SELECT update_id FROM bot_updates WHERE attempts<3 AND (status='pending' OR
        (status='working' AND started_at<now()-interval '2 minutes'))
        ORDER BY update_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND attempts<3 RETURNING payload,update_id`);
      if(!r.rowCount)break;
      const u=r.rows[0];
      try{
        const chatId=u.payload.callback_query?.message?.chat?.id||u.payload.message?.chat?.id;
        const action=()=>u.payload.callback_query?callback(pool,u.payload):message(pool,u.payload);
        if(Number.isSafeInteger(chatId))await withTelegramActivity(chatId,'typing',action);
        else await action();
        await pool.query("UPDATE bot_updates SET status='done' WHERE update_id=$1",[u.update_id]);
      }catch(e){console.error('[Telegram bot] failed',u.update_id,String(e?.message||e).slice(0,120));
        await pool.query("UPDATE bot_updates SET status=CASE WHEN attempts>=3 THEN 'done' ELSE 'pending' END WHERE update_id=$1",[u.update_id]);}
    }
  }catch(e){console.error('[Telegram bot] worker',String(e?.message||e).slice(0,100));}
  finally{busy=false;}
}

export async function registerWebhookIfEnabled(){
  if(process.env.TELEGRAM_WEBHOOK_AUTO_REGISTER!=='true')return;
  const host=process.env.PUBLIC_API_BASE_URL;
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  if(!host||!/^https:\/\/[a-z0-9.-]+\/?$/i.test(host)||!secret||! /^[A-Za-z0-9_-]{16,256}$/.test(secret)){
    console.error('[Telegram bot] webhook not registered: check PUBLIC_API_BASE_URL and secret');return;
  }
  const url=host.replace(/\/$/,'')+'/api/v1/telegram/webhook';
  await telegram('setWebhook',{url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:10});
  console.log('[Telegram bot] webhook registered');
}
