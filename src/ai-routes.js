import {dispatchSkillUpAction} from './agent-dispatch.js';
import {executeAgentAction} from './agent-actions.js';
import {parseFinanceIntent,appendFinance,financeReply,restoreLastFinance,financeCorrectionIntent,restoredFinanceReply} from './ai-finance.js';
import {handleAiMediaRoute} from './ai-media.js';
import {handleDevelopmentText} from './development-actions.js';
import {enrichFinanceCategory} from './category.js';
import {generateAgentAnswer,normalizeTimezone,validateInputMessage,legacyKey} from './ai.js';

const busyUsers=new Set();
function json(res,status,data,cors={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...cors});res.end(JSON.stringify(data));}
function safeError(error){if(error?.code==='model_rate_limited')return {status:429,code:'provider_rate_limited',message:'ИИ сейчас перегружен. Попробуй позже.'};return {status:502,code:'model_unavailable',message:'Не удалось получить ответ ИИ. Сообщение не записано.'};}
export async function handleAiRoute({req,res,pathname,pool,user,cors,readJsonBody}){
  if(['/api/v1/ai/media','/api/v1/ai/transcribe','/api/v1/ai/receipts/pending','/api/v1/ai/receipts/recent','/api/v1/ai/receipts/apply','/api/v1/ai/receipts/undo'].includes(pathname)) return handleAiMediaRoute({req,res,pathname,pool,user,cors,readJsonBody});
  if(req.method==='GET'&&pathname==='/api/v1/ai/history'){
    const rows=await pool.query('SELECT id, role, content AS text, created_at FROM (SELECT id,role,content,created_at FROM ai_messages WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100) recent ORDER BY created_at ASC,id ASC',[user.id]);
    return json(res,200,{messages:rows.rows},cors);
  }
  if(req.method==='POST'&&pathname==='/api/v1/ai/chat'){
    const body=await readJsonBody(req);
    if(!validateInputMessage(body?.message)||typeof body.requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId))return json(res,400,{error:'invalid_message'},cors);
    const id=String(user.id);
    const existing=await pool.query('SELECT id FROM ai_messages WHERE user_id=$1 AND request_id=$2',[id,body.requestId]);
    if(existing.rowCount){const answer=await pool.query('SELECT content AS answer FROM ai_messages WHERE user_id=$1 AND reply_to=$2 LIMIT 1',[id,body.requestId]);if(!answer.rowCount)return json(res,409,{error:'ai_busy',message:'Ответ ещё сохраняется. Повтори запрос чуть позже.'},cors);return json(res,200,{answer:answer.rows[0].answer,duplicate:true},cors);}
    if(busyUsers.has(id))return json(res,409,{error:'ai_busy',message:'Предыдущий ответ ещё формируется.'},cors);

    busyUsers.add(id);
    try {
      // All writes and undo requests use the same backend gateway as Telegram.
      const useLegacyGateway=process.env.AGENT_V2!=='true'||/^(?:удали\s+(?:все|всех)|верни|восстанови|отмени)/iu.test(body.message.trim());
      const protectedText=/^удали\s+все\s+(?:четыре|4)\s+цели[.!]?$/iu.test(body.message.trim())?'Удали все цели':body.message;
      const outcome=useLegacyGateway?await dispatchSkillUpAction({pool,user,text:protectedText,key:`chat:${body.requestId}`,timezone:req.headers?.['x-skillup-timezone']||'Asia/Bishkek'}):null;
      if(outcome){
        const answer=outcome.answer;
        const c=await pool.connect();
        try {await c.query('BEGIN');
          const added=await c.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[id,'user',body.message.trim(),body.requestId]);
          if(added.rowCount)await c.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES($1,$2,$3,$4)',[id,'assistant',answer,body.requestId]);
          await c.query('COMMIT');
        }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
        return json(res,200,{answer,agentAction:true,financeChanged:outcome.changed==='finances',developmentChanged:outcome.changed==='development',pending:!!outcome.pending},cors);
      }

    if(!(process.env.AI_PROVIDER==='openai'?process.env.OPENAI_API_KEY:process.env.ANTHROPIC_API_KEY))return json(res,503,{error:'ai_unconfigured',message:'ИИ временно недоступен; операции и их восстановление продолжают работать.'},cors);
    const count=await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at>now()-interval '1 day')::int AS today FROM ai_messages WHERE user_id=$1 AND role='user' AND legacy_key IS NULL AND created_at>now()-interval '1 day'",[id]);
    const fifteen=await pool.query("SELECT count(*)::int AS n FROM ai_messages WHERE user_id=$1 AND role='user' AND legacy_key IS NULL AND created_at>now()-interval '15 minutes'",[id]);
    if(count.rows[0].today>=50||fifteen.rows[0].n>=12)return json(res,429,{error:'limit_reached',message:'Лимит запросов: 12 за 15 минут и 50 в сутки.'},cors);
      const [history,doc]=await Promise.all([
        pool.query('SELECT role,content,created_at FROM ai_messages WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 18',[id]),
        pool.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='development'",[id])
      ]);
      const tz=normalizeTimezone(req.headers['x-skillup-timezone']);
      const focusItemId=typeof body.focusItemId==='string'?body.focusItemId.slice(0,90):'';
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),45_000);
      let answer;
      try{answer=await generateAgentAnswer({message:body.message.trim(),history:history.rows.reverse(),development:doc.rows[0]?.payload||{areas:[],items:[]},timezone:tz,focusItemId,signal:controller.signal,pool,user,key:`chat:${body.requestId}`});}
      finally{clearTimeout(timeout);}
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const added=await client.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[id,'user',body.message.trim(),body.requestId]);
        if(added.rowCount)await client.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES ($1,$2,$3,$4)',[id,'assistant',answer,body.requestId]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
      const mutation=await pool.query("SELECT 1 FROM finance_action_history WHERE user_id=$1 AND external_id=$2 AND state='active'",[id,`chat:${body.requestId}:0`]);
      return json(res,200,{answer,financeChanged:mutation.rowCount>0},cors);
    }catch(error){console.error('[AI] generation_failed',error?.code||error?.name||'unknown');const e=safeError(error);return json(res,e.status,{error:e.code,message:e.message},cors);}
    finally{busyUsers.delete(id);}
  }
  if(req.method==='POST'&&pathname==='/api/v1/ai/import-legacy'){
    const body=await readJsonBody(req);
    if(body?.confirmed!==true||!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>250)return json(res,400,{error:'invalid_legacy_import'},cors);
    const valid=body.messages.every(m=>m&&['user','assistant'].includes(m.role)&&typeof m.text==='string'&&m.text.trim().length>0&&m.text.length<=3000&&typeof m.scope==='string'&&m.scope.length<=100&&Number.isFinite(m.at)&&m.at>=1577836800000&&m.at<=Date.now()+86400000);
    if(!valid)return json(res,400,{error:'invalid_legacy_messages'},cors);
    const rows=body.messages.slice().sort((a,b)=>a.at-b.at);
    const client=await pool.connect();let added=0;
    try{
      await client.query('BEGIN');
      for(const m of rows){
        const prefix=(m.mode==='demo' && m.role==='assistant'?'[Исторический шаблонный ответ, НЕ реальный ИИ]\n':'')+(m.scope==='general'?'':`[Старый контекст: ${m.scope}]\n`);
        const content=(prefix+m.text.trim()).slice(0,12000);
        const r=await client.query("INSERT INTO ai_messages (user_id,role,content,legacy_key,created_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0)) ON CONFLICT DO NOTHING RETURNING id",[user.id,m.role,content,legacyKey(m),m.at]);added+=r.rowCount;
      }
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    return json(res,200,{imported:added,received:rows.length},cors);
  }
  return json(res,404,{error:'Not found'},cors);
}
