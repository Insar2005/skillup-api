import crypto from 'node:crypto';
import {generateAgentAnswer,validateInputMessage} from './ai.js';
import {classifyFinance,EXPENSE_CATEGORIES,INCOME_CATEGORIES} from './bot-finance.js';

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
async function say(chat_id,text,extra={}){
  const value=String(text||'').slice(0,3800);
  return telegram('sendMessage',{chat_id,text:value,...extra});
}
async function ensureUser(pool,tg){
  const r=await pool.query(`INSERT INTO users (telegram_id,first_name,last_name,username,language_code)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(telegram_id) DO UPDATE SET
    first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,updated_at=now()
    RETURNING id,telegram_id`,[tg.id,tg.first_name||null,tg.last_name||null,tg.username||null,tg.language_code||null]);
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
async function chatWithClaude(pool,user,chat,text){
  if(!process.env.ANTHROPIC_API_KEY){await say(chat,'Claude пока не подключён. Добавь ANTHROPIC_API_KEY в Railway.');return;}
  if(!validateInputMessage(text)){await say(chat,'Сообщение слишком длинное. Напиши короче (до 1500 символов).');return;}
  const reqId=crypto.randomUUID();
  const [hist,dev]=await Promise.all([
    pool.query('SELECT role,content FROM ai_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 14',[user.id]),
    pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development'",[user.id])
  ]);
  const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),45000);
  let answer;
  try{answer=await generateAgentAnswer({message:text,history:hist.rows.reverse(),development:dev.rows[0]?.payload||{areas:[],items:[]},timezone:process.env.DEFAULT_TIMEZONE||'Asia/Bishkek',signal:ctrl.signal});}
  finally{clearTimeout(timeout);}
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES($1,$2,$3,$4)',[user.id,'user',text,reqId]);
    await client.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES($1,$2,$3,$4)',[user.id,'assistant',answer,reqId]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await say(chat,answer);
}
async function message(pool,update){
  const m=update.message;if(!isPrivate(m))return;
  const user=await ensureUser(pool,m.from),chat=m.chat.id;
  if(m.text==='/start'||m.text==='/help'){await say(chat,'SkillUp — твой помощник по целям и финансам. Напиши вопрос, отправь голосовое или попробуй:\n«Потратил 1250 на продукты»\n«Получил зарплату 45000»\n«Как мой прогресс за 7 дней?»\nФинансовые записи добавляются только после подтверждения.');return;}
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
  const classified=classifyFinance(text);
  if(classified){await prepareFinance(pool,user,chat,text,classified);return;}
  await chatWithClaude(pool,user,chat,text);
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
      try{if(u.payload.callback_query)await callback(pool,u.payload);else await message(pool,u.payload);
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
