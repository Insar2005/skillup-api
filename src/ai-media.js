// SkillUp v29.5: authenticated, ephemeral media processing for the unified AI chat.
// Uploaded media never goes to logs or permanent storage; only extracted receipt drafts do.
import crypto from 'node:crypto';

const MAX_PHOTO = 6 * 1024 * 1024;
const MAX_AUDIO = 8 * 1024 * 1024;
const CURRENCIES = new Set(['RUB','KGS','USD','EUR','KZT','UZS','CNY','TRY','AED','GBP']);
const KNOWN_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'application/pdf': 'document'
};
function send(res,status,value,cors={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...cors});res.end(JSON.stringify(value));}
async function bodyBytes(req,max){
  let size=0;const chunks=[];
  for await(const c of req){size+=c.length;if(size>max){const e=new Error('File is too large');e.status=413;throw e;}chunks.push(c);}
  return Buffer.concat(chunks);
}
function sniff(buffer){
  if(buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'image/jpeg';
  if(buffer.subarray(0,8).toString('hex')==='89504e470d0a1a0a')return 'image/png';
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(buffer.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  return '';
}
function extractJson(s){const text=String(s||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();const a=text.indexOf('{'),b=text.lastIndexOf('}');if(a<0||b<a)throw new Error('model_invalid_json');return JSON.parse(text.slice(a,b+1));}
function cleanMoney(x){const n=Number(x);return Number.isFinite(n)&&n>0&&n<1e10&&Math.abs(Math.round(n*100)-n*100)<0.0001?Math.round(n*100)/100:null;}
function cleanItem(v){if(!v||typeof v!=='object')return null;const amount=cleanMoney(v.amount);if(!amount)return null;const label=String(v.name||v.title||'Покупка').trim().slice(0,120);const category=String(v.category||'Покупки').trim().slice(0,48);return {name:label||'Покупка',amount,category:category||'Покупки'};}
export function validateReceiptCandidate(value){
  if(!value||value.kind!=='receipt'||!Array.isArray(value.items))return null;
  const currency=String(value.currency||'').toUpperCase();
  const total=cleanMoney(value.total);
  const items=value.items.slice(0,35).map(cleanItem).filter(Boolean);
  const sum=items.reduce((x,y)=>x+y.amount,0);
  // Avoid double-counting receipt subtotals and totals: when line items do not
  // reconcile, import a *single* receipt total instead of unreliable breakdown.
  const match=total&&items.length&&Math.abs(sum-total)<=Math.max(.02,total*.005);
  const rows=match?items:(total?[{name:String(value.merchant||'Покупка по чеку').slice(0,120),category:'Покупки',amount:total}]:[]);
  if(!rows.length)return null;
  return {currency:CURRENCIES.has(currency)?currency:null,total:total||Math.round(sum*100)/100,items:rows,merchant:String(value.merchant||'').slice(0,120),direction:value.direction==='income'?'income':'expense',reconciled:!!match};
}
export async function anthropicMedia(buffer,mime,question,signal){
  const system='Ты — помощник SkillUp. Анализируй переданное изображение или PDF. Если это фискальный/кассовый чек, верни ТОЛЬКО JSON: {"kind":"receipt","merchant":"...","currency":"KGS|RUB|USD|EUR|...|null","direction":"expense|income","total":число|null,"items":[{"name":"...","amount":число,"category":"Продукты|Жилье|Транспорт|Гаджеты|Личные расходы|Здоровье|Еда вне дома|Покупки|..."}]}. Поле amount означает ПОЛНУЮ цену строки с учётом количества, а не цену за одну штуку. Не включай отдельными позициями итог, налог и сдачу. Не выдумывай неразборчивые цены; не угадывай валюту по геолокации. Если это не чек, верни JSON {"kind":"other","answer":"короткий ответ по запросу пользователя"}. В ответе для other максимум 3 предложения.';
  const content=[mime==='application/pdf'?{type:'document',source:{type:'base64',media_type:mime,data:buffer.toString('base64')}}:{type:'image',source:{type:'base64',media_type:mime,data:buffer.toString('base64')}},{type:'text',text:question||'Распознай документ. Если это чек, подготовь категории и суммы.'}];
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal,headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||'claude-sonnet-5-5',max_tokens:2200,system,messages:[{role:'user',content}]})});
  if(!r.ok){console.warn('[Media] Claude status',r.status);throw new Error('claude_unavailable');}
  const data=await r.json();return extractJson(data.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
}
export async function inspectReceiptMedia(buffer,mime,question=''){
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),45000);
 try{const output=await anthropicMedia(buffer,mime,question,ctrl.signal);return {output,receipt:validateReceiptCandidate(output)};}
 finally{clearTimeout(timer);}
}
export async function saveReceiptDraft(pool,userId,receipt){
 const id=crypto.randomUUID();
 await pool.query('INSERT INTO ai_receipt_drafts(id,user_id,payload) VALUES($1,$2,$3::jsonb)',[id,userId,JSON.stringify(receipt)]);
 return id;
}
async function writeChatMedia(pool,userId,userText,reply){
  // Keeps a useful, privacy-preserving marker in the shared chat; never stores original bytes.
  const requestId=crypto.randomUUID();
  await pool.query('INSERT INTO ai_messages(user_id,role,content,request_id) VALUES($1,$2,$3,$4)',[userId,'user',userText.slice(0,1000),requestId]);
  await pool.query('INSERT INTO ai_messages(user_id,role,content,reply_to) VALUES($1,$2,$3,$4)',[userId,'assistant',reply.slice(0,1500),requestId]);
}
async function analyze({req,res,pool,user,cors}){
  if(!process.env.ANTHROPIC_API_KEY)return send(res,503,{message:'ИИ не настроен'},cors);
  const data=await bodyBytes(req,MAX_PHOTO);
  const mime=sniff(data);
  if(!KNOWN_TYPES[mime])return send(res,415,{message:'Поддерживаются JPG, PNG, WebP и PDF'},cors);
  if(data.length<100)return send(res,400,{message:'Файл пустой или повреждён'},cors);
  const count=await pool.query("SELECT count(*)::int AS n FROM ai_messages WHERE user_id=$1 AND content LIKE '📎%' AND created_at>now()-interval '1 hour'",[user.id]);
  if(count.rows[0].n>=15)return send(res,429,{message:'Не более 15 документов в час'},cors);
  const question=String(req.headers['x-skillup-photo-prompt']||'').slice(0,400);
  const {output,receipt}=await inspectReceiptMedia(data,mime,question);
  if(!receipt){
    const answer=String(output?.answer||'Не удалось уверенно распознать чек. Пришли более чёткую фотографию.').slice(0,1000);
    await writeChatMedia(pool,user.id,'📎 Фото или документ',answer);
    return send(res,200,{kind:'other',answer},cors);
  }
  const id=await saveReceiptDraft(pool,user.id,receipt);
  // Save immediately only when totals reconcile AND currency was readable on the receipt.
  const saved=receipt.reconciled&&receipt.currency?await commitReceiptDraft(pool,user,id,receipt.currency):null;
  const note=saved?.saved?`Записал ${saved.count} операций по чеку на ${receipt.total} ${receipt.currency}. Можно отменить последний импорт.`:`Нашёл чек: ${receipt.items.length} позиций, ${receipt.total} ${receipt.currency||'(валюта не указана)'}. Проверь сумму перед массовым сохранением.`;
  await writeChatMedia(pool,user.id,'📎 Чек'+(receipt.merchant?' · '+receipt.merchant:''),note);
  return send(res,200,{kind:'receipt',id,receipt,autoSaved:!!saved?.saved,needsCurrency:!receipt.currency},cors);
}
async function transcribe({req,res,cors}){
  if(!process.env.OPENAI_API_KEY)return send(res,503,{message:'Для голосовых требуется OPENAI_API_KEY в Railway'},cors);
  const bytes=await bodyBytes(req,MAX_AUDIO);
  const mime=String(req.headers['content-type']||'').split(';')[0].trim();
  if(!['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/mp3'].includes(mime))return send(res,415,{message:'Неподдерживаемый формат записи'},cors);
  if(bytes.length<100||bytes.length>MAX_AUDIO)return send(res,400,{message:'Пустая или слишком большая запись'},cors);
  const ext=mime==='audio/ogg'?'ogg':mime==='audio/mp4'||mime==='audio/x-m4a'?'m4a':mime==='audio/wav'?'wav':mime==='audio/mpeg'||mime==='audio/mp3'?'mp3':'webm';
  const fd=new FormData();fd.append('model',process.env.TRANSCRIPTION_MODEL||'whisper-1');fd.append('file',new Blob([bytes],{type:mime}),`voice.${ext}`);
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),30000);
  try{
    const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:fd});
    if(!r.ok){console.warn('[Media] transcription status',r.status);return send(res,502,{message:'Не удалось распознать голосовое'},cors);}
    const json=await r.json();return send(res,200,{text:String(json?.text||'').slice(0,1500)},cors);
  }finally{clearTimeout(timer);}
}
async function recent({res,pool,user,cors}){
 const r=await pool.query("SELECT id,payload,created_at FROM ai_receipt_drafts WHERE user_id=$1 AND status='applied' ORDER BY applied_at DESC LIMIT 1",[user.id]);
 return send(res,200,{recent:r.rows},cors);
}
async function pending({res,pool,user,cors}){
  const r=await pool.query("SELECT id,payload,created_at FROM ai_receipt_drafts WHERE user_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 5",[user.id]);
  return send(res,200,{drafts:r.rows},cors);
}
export async function commitReceiptDraft(pool,user,id,forcedCurrency=''){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const dr=await client.query('SELECT * FROM ai_receipt_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id]);
  if(!dr.rowCount){await client.query('ROLLBACK');return {status:404,message:'Чек не найден'};}
  const draft=dr.rows[0];
  if(draft.status==='applied'){await client.query('ROLLBACK');return {status:200,saved:true,already:true};}
  if(draft.status!=='pending'||new Date(draft.expires_at)<new Date()){await client.query('ROLLBACK');return {status:409,message:'Срок хранения черновика истёк'};}
  const receipt=draft.payload;
  const currency=receipt.currency||forcedCurrency;
  if(!CURRENCIES.has(currency)){await client.query('ROLLBACK');return {status:422,message:'Укажи валюту чека'};}
  const doc=await client.query("SELECT payload,revision FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  const stored=doc.rows[0]?.payload||{entries:[],savingsGoal:null};
  if(!Array.isArray(stored.entries)||stored.entries.length>500){await client.query('ROLLBACK');return {status:422,message:'Достигнут лимит операций'};}
  const existing=new Set(stored.entries.map(e=>e.externalId));
  const now=new Date().toISOString();
  const additions=receipt.items.map((item,i)=>({externalId:`receipt:${draft.id}:${i}`,type:receipt.direction==='income'?'Доход':'Расход',category:item.category,note:[receipt.merchant,item.name].filter(Boolean).join(' · ').slice(0,250),amount:item.amount,currency,date:now,source:'receipt'})).filter(x=>!existing.has(x.externalId));
  if(stored.entries.length+additions.length>500){await client.query('ROLLBACK');return {status:422,message:'Слишком много операций'};}
  const next={...stored,entries:[...additions,...stored.entries]};
  if(doc.rowCount)await client.query("UPDATE user_documents SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='finances'",[user.id,'finances',JSON.stringify(next)]);
  else await client.query("INSERT INTO user_documents(user_id,kind,payload) VALUES($1,'finances',$2::jsonb)",[user.id,JSON.stringify(next)]);
  await client.query("UPDATE ai_receipt_drafts SET status='applied', applied_at=now(),payload=jsonb_set(payload,'{currency}',to_jsonb($2::text)) WHERE id=$1",[draft.id,currency]);
  await client.query('COMMIT');
  return {status:200,saved:true,count:additions.length,currency,total:receipt.total};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function undoReceiptDraft(pool,user,id){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const d=await c.query('SELECT id,status FROM ai_receipt_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id]);
  if(!d.rowCount||d.rows[0].status!=='applied'){await c.query('ROLLBACK');return false;}
  const row=await c.query("SELECT payload FROM user_documents WHERE user_id=$1 AND kind='finances' FOR UPDATE",[user.id]);
  const doc=row.rows[0]?.payload;
  if(!Array.isArray(doc?.entries)){await c.query('ROLLBACK');return false;}
  const next={...doc,entries:doc.entries.filter(e=>!String(e.externalId||'').startsWith(`receipt:${id}:`))};
  if(next.entries.length===doc.entries.length){await c.query('ROLLBACK');return false;}
  await c.query("UPDATE user_documents SET payload=$2::jsonb,revision=revision+1,updated_at=now() WHERE user_id=$1 AND kind='finances'",[user.id,JSON.stringify(next)]);
  await c.query("UPDATE ai_receipt_drafts SET status='cancelled' WHERE id=$1",[id]);
  await c.query('COMMIT');return true;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function apply({req,res,pool,user,cors,readJsonBody}){
 const body=await readJsonBody(req);
 if(!/^[a-f0-9-]{36}$/i.test(String(body?.id||'')))return send(res,400,{message:'Недопустимый номер чека'},cors);
 const result=await commitReceiptDraft(pool,user,body.id,String(body?.currency||'').toUpperCase());
 const {status,...payload}=result;return send(res,status,payload,cors);
}

async function undo({req,res,pool,user,cors,readJsonBody}){
 const body=await readJsonBody(req);
 if(!/^[a-f0-9-]{36}$/i.test(String(body?.id||'')))return send(res,400,{message:'Недопустимый чек'},cors);
 const success=await undoReceiptDraft(pool,user,body.id);
 return send(res,success?200:409,{undone:success,message:success?'Операции отменены':'Чек не найден или уже отменён'},cors);
}
export async function handleAiMediaRoute(args){
  const {pathname,req,res,cors}=args;
  if(req.method==='POST'&&pathname==='/api/v1/ai/media')return analyze(args);
  if(req.method==='POST'&&pathname==='/api/v1/ai/transcribe')return transcribe(args);
  if(req.method==='GET'&&pathname==='/api/v1/ai/receipts/pending')return pending(args);
  if(req.method==='GET'&&pathname==='/api/v1/ai/receipts/recent')return recent(args);
  if(req.method==='POST'&&pathname==='/api/v1/ai/receipts/undo')return undo(args);
  if(req.method==='POST'&&pathname==='/api/v1/ai/receipts/apply')return apply(args);
  return send(res,404,{error:'Not found'},cors);
}
